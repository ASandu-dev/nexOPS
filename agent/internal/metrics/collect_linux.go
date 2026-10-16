//go:build linux

package metrics

import (
	"context"
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

// collect is the linux implementation; see Collect for the contract.
func (c *Collector) collect(ctx context.Context) protocol.HeartbeatRequest {
	hb := protocol.HeartbeatRequest{
		Disks:    []protocol.DiskUsage{},
		Net:      []protocol.NetInterface{},
		Services: []protocol.ServiceState{},
	}

	if v, ok := collectCPU(ctx); ok {
		hb.CPUPct = &v
	}
	if n := runtime.NumCPU(); n > 0 {
		hb.Cores = &n
	}
	if l1, l5, l15, err := collectLoadavg(); err == nil {
		hb.Load1, hb.Load5, hb.Load15 = &l1, &l5, &l15
	}

	if mi, err := collectMeminfo(); err == nil {
		total := int64(mi.Total)
		hb.MemTotalBytes = total
		hb.MemUsedBytes = int64(mi.MemUsedBytes())
		hb.MemAvailableBytes = int64(mi.MemAvailableBytes())
		swap := int64(mi.SwapUsedBytes())
		hb.SwapUsedBytes = &swap
	}

	hb.Disks = collectDisks()

	if nets := c.collectNet(); nets != nil {
		hb.Net = nets
	}

	if up, err := collectUptime(); err == nil {
		sec := int64(up)
		hb.UptimeSec = &sec
		boot := time.Now().UTC().Add(-time.Duration(up) * time.Second)
		s := boot.Truncate(time.Second).Format(time.RFC3339)
		hb.BootTime = &s
	}

	if k, err := collectKernel(); err == nil {
		hb.Kernel = &k
	}

	if h, err := os.Hostname(); err == nil {
		hb.Hostname = h
	}

	hb.Services = collectServices(ctx, c.watched)
	hb.PkgUpdates = c.collectPkgUpdates(ctx)

	hb.CapturedAt = time.Now().UTC().Format(time.RFC3339)
	return hb
}

// collectCPU takes two /proc/stat samples spaced cpuSampleWindow apart.
// Returns nil on read failure or a non-positive delta so the backend stores
// null instead of a bogus 0.
func collectCPU(ctx context.Context) (float64, bool) {
	raw1, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, false
	}
	s1, err := parseProcStat(strings.NewReader(string(raw1)))
	if err != nil {
		return 0, false
	}
	timer := time.NewTimer(cpuSampleWindow)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return 0, false
	case <-timer.C:
	}
	raw2, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, false
	}
	s2, err := parseProcStat(strings.NewReader(string(raw2)))
	if err != nil {
		return 0, false
	}
	return cpuPctBetween(s1, s2)
}

func collectLoadavg() (l1, l5, l15 float64, err error) {
	raw, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0, 0, 0, err
	}
	return parseLoadavg(string(raw))
}

func collectMeminfo() (Meminfo, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return Meminfo{}, err
	}
	defer f.Close()
	return parseMeminfo(f)
}

// collectDisks statfs-es every reportable mount. Unreadable mounts are
// skipped (e.g. FUSE mounts that vanished mid-walk).
func collectDisks() []protocol.DiskUsage {
	f, err := os.Open("/proc/mounts")
	if err != nil {
		return []protocol.DiskUsage{}
	}
	defer f.Close()
	mounts, err := parseMounts(f)
	if err != nil {
		return []protocol.DiskUsage{}
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
	return out
}

// collectNet converts cumulative /proc/net/dev counters into rates using the
// previous sample. The first sample reports rate 0 (no baseline). Returns nil
// when /proc/net/dev cannot be read.
func (c *Collector) collectNet() []protocol.NetInterface {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return nil
	}
	defer f.Close()
	cur, err := parseNetDev(f)
	if err != nil {
		return nil
	}

	now := time.Now()
	var elapsed float64
	if !c.prevNetAt.IsZero() {
		elapsed = now.Sub(c.prevNetAt).Seconds()
	}
	out := make([]protocol.NetInterface, 0, len(cur))
	for name, counters := range cur {
		if name == "lo" {
			continue
		}
		var rxRate, txRate float64
		if prev, ok := c.prevNet[name]; ok && elapsed > 0 {
			rxRate, txRate = netRate(prev, counters, elapsed)
		}
		out = append(out, protocol.NetInterface{
			Name:      name,
			RxBytes:   int64(counters.rx),
			TxBytes:   int64(counters.tx),
			RxRateBps: rxRate,
			TxRateBps: txRate,
		})
	}
	// Map iteration order is random; sort by name for stable telemetry rows.
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	c.prevNet = cur
	c.prevNetAt = now
	return out
}

func collectUptime() (float64, error) {
	raw, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0, err
	}
	return parseUptime(string(raw))
}

func collectKernel() (string, error) {
	raw, err := os.ReadFile("/proc/sys/kernel/osrelease")
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

// collectPkgUpdates simulates an apt upgrade to count pending updates and
// checks for /var/run/reboot-required. Results are cached for pkgCacheTTL.
// Returns nil when apt is unavailable or the simulation fails — the wire
// contract is "null when not measured".
func (c *Collector) collectPkgUpdates(ctx context.Context) *protocol.PkgUpdateSummary {
	c.pkgMu.Lock()
	defer c.pkgMu.Unlock()
	if c.pkg != nil && time.Since(c.pkg.at) < pkgCacheTTL {
		return c.pkg.val
	}
	val := measurePkgUpdates(ctx)
	c.pkg = &pkgCache{at: time.Now(), val: val}
	return val
}

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
