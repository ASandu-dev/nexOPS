//go:build linux

package metrics

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/nexops/agent/internal/apt"
	"github.com/nexops/agent/internal/protocol"
	"github.com/nexops/agent/internal/units"
)

// read resolves the collector's file reader, defaulting to the real
// filesystem. Tests inject a reader to exercise failure aggregation.
func (c *Collector) read(path string) ([]byte, error) {
	if c.readFile != nil {
		return c.readFile(path)
	}
	return os.ReadFile(path)
}

// collect is the linux implementation; see Collect for the contract.
func (c *Collector) collect(ctx context.Context) protocol.HeartbeatRequest {
	hb := protocol.HeartbeatRequest{
		CPUModel: "unknown",
		Disks:    []protocol.DiskUsage{},
		DiskIO:   []protocol.DiskIOStat{},
		Net:      []protocol.NetInterface{},
		Services: []protocol.ServiceState{},
	}
	var errs collectionErrors

	if model, err := c.collectCPUModel(); err == nil {
		hb.CPUModel = model
	} else {
		errs.add("cpuModel", err)
	}

	if v, err := c.collectCPU(ctx); err == nil {
		hb.CPUPct = &v
	} else {
		errs.add("cpu", err)
	}
	if n := runtime.NumCPU(); n > 0 {
		hb.Cores = &n
	}
	if l1, l5, l15, err := c.collectLoadavg(); err == nil {
		hb.Load1, hb.Load5, hb.Load15 = &l1, &l5, &l15
	} else {
		errs.add("loadavg", err)
	}

	if mi, err := c.collectMeminfo(); err == nil {
		total := int64(mi.Total)
		hb.MemTotalBytes = total
		hb.MemUsedBytes = int64(mi.MemUsedBytes())
		hb.MemAvailableBytes = int64(mi.MemAvailableBytes())
		swapTotal := int64(mi.SwapTotal)
		hb.SwapTotalBytes = &swapTotal
		swapUsed := int64(mi.SwapUsedBytes())
		hb.SwapUsedBytes = &swapUsed
	} else {
		errs.add("meminfo", err)
	}

	if disks, err := c.collectDisks(); err == nil {
		hb.Disks = disks
	} else {
		errs.add("disks", err)
	}

	if nets, err := c.collectNet(); err == nil {
		hb.Net = nets
	} else {
		errs.add("net", err)
	}

	if stats, err := c.collectDiskIO(); err == nil {
		hb.DiskIO = stats
	} else {
		errs.add("diskIO", err)
	}

	if pretty, err := c.collectOSPrettyName(); err == nil {
		hb.OSPrettyName = pretty
	} else {
		errs.add("osPrettyName", err)
	}

	if up, err := c.collectUptime(); err == nil {
		sec := int64(up)
		hb.UptimeSec = &sec
		boot := time.Now().UTC().Add(-time.Duration(up) * time.Second)
		s := boot.Truncate(time.Second).Format(time.RFC3339)
		hb.BootTime = &s
	} else {
		errs.add("uptime", err)
	}

	if k, err := c.collectKernel(); err == nil {
		hb.Kernel = &k
	} else {
		errs.add("kernel", err)
	}

	if h, err := os.Hostname(); err == nil {
		hb.Hostname = h
	} else {
		errs.add("hostname", err)
	}

	hb.Services = collectServices(ctx, c.watched)
	// Read the background-refreshed cache; never measure apt on the beat path.
	hb.PkgUpdates = c.collectPkgUpdates()

	hb.CollectionErrors = errs
	hb.CapturedAt = time.Now().UTC().Format(time.RFC3339)
	return hb
}

// collectCPU takes two /proc/stat samples spaced cpuSampleWindow apart.
// Returns an error on read failure or a non-positive delta so the backend
// stores null instead of a bogus 0 and the failure is reported.
func (c *Collector) collectCPU(ctx context.Context) (float64, error) {
	raw1, err := c.read("/proc/stat")
	if err != nil {
		return 0, err
	}
	s1, err := parseProcStat(strings.NewReader(string(raw1)))
	if err != nil {
		return 0, err
	}
	timer := time.NewTimer(cpuSampleWindow)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	case <-timer.C:
	}
	raw2, err := c.read("/proc/stat")
	if err != nil {
		return 0, err
	}
	s2, err := parseProcStat(strings.NewReader(string(raw2)))
	if err != nil {
		return 0, err
	}
	pct, ok := cpuPctBetween(s1, s2)
	if !ok {
		return 0, fmt.Errorf("counters unchanged or reset")
	}
	return pct, nil
}

func (c *Collector) collectLoadavg() (l1, l5, l15 float64, err error) {
	raw, err := c.read("/proc/loadavg")
	if err != nil {
		return 0, 0, 0, err
	}
	return parseLoadavg(string(raw))
}

func (c *Collector) collectMeminfo() (Meminfo, error) {
	raw, err := c.read("/proc/meminfo")
	if err != nil {
		return Meminfo{}, err
	}
	return parseMeminfo(strings.NewReader(string(raw)))
}

// collectDisks statfs-es every reportable mount. Unreadable mounts are
// skipped (e.g. FUSE mounts that vanished mid-walk).
func (c *Collector) collectDisks() ([]protocol.DiskUsage, error) {
	raw, err := c.read("/proc/mounts")
	if err != nil {
		return []protocol.DiskUsage{}, err
	}
	mounts, err := parseMounts(strings.NewReader(string(raw)))
	if err != nil {
		return []protocol.DiskUsage{}, err
	}
	selected := selectDisks(mounts)
	out := make([]protocol.DiskUsage, 0, len(selected))
	for _, m := range selected {
		var st syscall.Statfs_t
		if err := syscall.Statfs(m.mountPoint, &st); err != nil {
			continue
		}
		bsize := uint64(st.Bsize)
		total := st.Blocks * bsize
		var used uint64
		if st.Bfree <= st.Blocks {
			used = (st.Blocks - st.Bfree) * bsize
		}
		var inodesTotal, inodesUsed int64
		if st.Files > 0 {
			inodesTotal = int64(st.Files)
			if st.Ffree <= st.Files {
				inodesUsed = int64(st.Files - st.Ffree)
			}
		}
		out = append(out, protocol.DiskUsage{
			Mount:       m.mountPoint,
			FSType:      m.fsType,
			TotalBytes:  int64(total),
			UsedBytes:   int64(used),
			InodesTotal: inodesTotal,
			InodesUsed:  inodesUsed,
		})
	}
	return out, nil
}

// collectNet converts cumulative /proc/net/dev counters into rates using the
// previous sample. The first sample reports rate 0 (no baseline). Returns an
// error when /proc/net/dev cannot be read. Address and operstate lookup are
// supplementary: they degrade to empty/unknown without failing the collector.
func (c *Collector) collectNet() ([]protocol.NetInterface, error) {
	raw, err := c.read("/proc/net/dev")
	if err != nil {
		return nil, err
	}
	cur, err := parseNetDev(strings.NewReader(string(raw)))
	if err != nil {
		return nil, err
	}

	addresses := interfaceAddresses()
	now := time.Now()
	var elapsed float64
	if !c.prevNetAt.IsZero() {
		elapsed = now.Sub(c.prevNetAt).Seconds()
	}
	out := make([]protocol.NetInterface, 0, len(cur))
	for name, counters := range cur {
		var rxRate, txRate float64
		if prev, ok := c.prevNet[name]; ok && elapsed > 0 {
			rxRate, txRate = netRate(prev, counters, elapsed)
		}
		ips := addresses[name]
		if ips == nil {
			ips = []string{}
		}
		out = append(out, protocol.NetInterface{
			Name:      name,
			RxBytes:   int64(counters.rx),
			TxBytes:   int64(counters.tx),
			RxRateBps: rxRate,
			TxRateBps: txRate,
			IPs:       ips,
			Operstate: c.collectOperstate(name),
		})
	}
	// Map iteration order is random; sort by name for stable telemetry rows.
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	c.prevNet = cur
	c.prevNetAt = now
	return out, nil
}

// collectDiskIO converts cumulative /proc/diskstats counters into per-device
// rates using the previous sample. The first sample reports null rates (no
// baseline). Returns an error when /proc/diskstats cannot be read.
func (c *Collector) collectDiskIO() ([]protocol.DiskIOStat, error) {
	raw, err := c.read("/proc/diskstats")
	if err != nil {
		return nil, err
	}
	cur, err := parseDiskstats(strings.NewReader(string(raw)))
	if err != nil {
		return nil, err
	}

	now := time.Now()
	var elapsed float64
	if !c.prevDiskIOAt.IsZero() {
		elapsed = now.Sub(c.prevDiskIOAt).Seconds()
	}
	out := make([]protocol.DiskIOStat, 0, len(cur))
	for device, counters := range cur {
		stat := protocol.DiskIOStat{
			Device:     device,
			ReadBytes:  int64(counters.read),
			WriteBytes: int64(counters.write),
		}
		if prev, ok := c.prevDiskIO[device]; ok && elapsed > 0 {
			stat.ReadRateBps, stat.WriteRateBps = diskRate(prev, counters, elapsed)
		}
		out = append(out, stat)
	}
	// Map iteration order is random; sort by device for stable telemetry rows.
	sort.Slice(out, func(i, j int) bool { return out[i].Device < out[j].Device })
	c.prevDiskIO = cur
	c.prevDiskIOAt = now
	return out, nil
}

// collectCPUModel reads /proc/cpuinfo; an unreadable file is reported but the
// heartbeat still carries "unknown".
func (c *Collector) collectCPUModel() (string, error) {
	raw, err := c.read("/proc/cpuinfo")
	if err != nil {
		return "unknown", err
	}
	return parseCPUModel(strings.NewReader(string(raw))), nil
}

// collectOSPrettyName returns PRETTY_NAME from os-release. A readable file
// without PRETTY_NAME yields "" (the operator-visible "absent" value).
func (c *Collector) collectOSPrettyName() (string, error) {
	var lastErr error
	for _, path := range []string{"/etc/os-release", "/usr/lib/os-release"} {
		raw, err := c.read(path)
		if err != nil {
			lastErr = err
			continue
		}
		vals, err := parseOsRelease(strings.NewReader(string(raw)))
		if err != nil {
			lastErr = err
			continue
		}
		return vals["PRETTY_NAME"], nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("os-release not found")
	}
	return "", lastErr
}

// collectOperstate reads the kernel's operstate for an interface. Missing or
// unrecognised values degrade to "unknown" (loopback commonly reports
// "unknown" and is preserved as such).
func (c *Collector) collectOperstate(name string) string {
	raw, err := c.read("/sys/class/net/" + name + "/operstate")
	if err != nil {
		return "unknown"
	}
	return parseOperstate(string(raw))
}

// interfaceAddresses maps each interface to its IPv4/IPv6 addresses without
// CIDR prefixes. Lookup failure is non-fatal: callers report an empty list.
func interfaceAddresses() map[string][]string {
	out := map[string][]string{}
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, iface := range ifaces {
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		out[iface.Name] = formatIPAddresses(addrs)
	}
	return out
}

func (c *Collector) collectUptime() (float64, error) {
	raw, err := c.read("/proc/uptime")
	if err != nil {
		return 0, err
	}
	return parseUptime(string(raw))
}

func (c *Collector) collectKernel() (string, error) {
	raw, err := c.read("/proc/sys/kernel/osrelease")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(raw)), nil
}

// collectServices asks systemd for each watched unit's ActiveState.
// systemctl missing (or a non-systemd host) yields an empty list; individual
// unit failures report "unknown".
func collectServices(ctx context.Context, watched []string) []protocol.ServiceState {
	out := []protocol.ServiceState{}
	if len(watched) == 0 {
		return out
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		return out
	}
	for _, unit := range watched {
		if !units.ValidName(unit) {
			continue // defence in depth; config already validated
		}
		state := "unknown"
		uctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		cmd := exec.CommandContext(uctx, "systemctl", "show", "-p", "ActiveState", "--value", unit)
		if raw, err := cmd.Output(); err == nil {
			if v := strings.TrimSpace(string(raw)); v != "" {
				state = v
			}
		}
		cancel()
		out = append(out, protocol.ServiceState{Name: unit, State: state})
	}
	return out
}

// measurePkgUpdates simulates an apt upgrade to count pending updates and
// checks for /var/run/reboot-required. It is expensive, so it runs only on the
// Collector's background refresher (see Start). Returns nil when apt is
// unavailable or the simulation fails — the wire contract is "null when not
// measured".
func measurePkgUpdates(ctx context.Context) *protocol.PkgUpdateSummary {
	if !apt.Available() {
		return nil
	}
	actx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	// Simulate goes through the sudoers apt helper when installed (unlike the
	// direct apt-get call this replaced, which needed root the agent lacks).
	cmd, err := apt.AptCommand(actx, apt.Simulate)
	if err != nil {
		return nil
	}
	raw, err := cmd.Output()
	if err != nil {
		return nil
	}
	count := 0
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "Inst ") {
			count++
		}
	}
	_, rebootErr := os.Stat("/var/run/reboot-required")
	return &protocol.PkgUpdateSummary{
		AvailableCount: count,
		RebootRequired: rebootErr == nil,
	}
}
