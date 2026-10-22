// Package metrics collects host telemetry from /proc, /sys and systemd.
//
// Parsing is split from collection: every parse* function is pure and
// portable (unit-tested against fixture content), while the /proc reads,
// statfs calls and subprocess calls live behind linux build tags.
package metrics

import (
	"bufio"
	"fmt"
	"io"
	"math"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
)

// Meminfo holds the /proc/meminfo values NexOPS needs, in bytes.
// Available is the kernel's MemAvailable (not MemFree) so the control plane
// gets Linux-correct "how much can a new workload actually use" accounting.
type Meminfo struct {
	Total        uint64
	Free         uint64
	Available    uint64 // 0 when the kernel lacks MemAvailable (< 3.14)
	HasAvailable bool
	Buffers      uint64
	Cached       uint64
	SReclaimable uint64
	Shmem        uint64
	SwapTotal    uint64
	SwapFree     uint64
}

// MemAvailableBytes returns MemAvailable when present, else the kernel's
// documented fallback estimate: MemFree + Buffers + Cached + SReclaimable −
// Shmem (shmem is page-cache resident but not reclaimable).
func (m Meminfo) MemAvailableBytes() uint64 {
	if m.HasAvailable {
		return m.Available
	}
	avail := m.Free + m.Buffers + m.Cached + m.SReclaimable
	if avail >= m.Shmem {
		avail -= m.Shmem
	} else {
		avail = 0
	}
	if avail > m.Total {
		avail = m.Total
	}
	return avail
}

// MemUsedBytes is Total − Available (the accounting used by modern `htop`/
// `free`; matches the control plane's dashboard expectations).
func (m Meminfo) MemUsedBytes() uint64 {
	avail := m.MemAvailableBytes()
	if avail > m.Total {
		return 0
	}
	return m.Total - avail
}

// SwapUsedBytes is SwapTotal − SwapFree.
func (m Meminfo) SwapUsedBytes() uint64 {
	if m.SwapFree > m.SwapTotal {
		return 0
	}
	return m.SwapTotal - m.SwapFree
}

// parseMeminfo parses /proc/meminfo. Values are reported in kB and converted
// to bytes. Unknown keys are ignored; duplicate keys keep the first (the
// kernel never emits duplicates, but be strict about parsing garbage).
func parseMeminfo(r io.Reader) (Meminfo, error) {
	var m Meminfo
	seen := map[string]bool{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := sc.Text()
		colon := strings.IndexByte(line, ':')
		if colon <= 0 {
			continue
		}
		key := line[:colon]
		if seen[key] {
			continue
		}
		fields := strings.Fields(line[colon+1:])
		if len(fields) == 0 {
			continue
		}
		val, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		// /proc/meminfo reports kB (kibibytes); tolerate a missing unit.
		if len(fields) < 2 || fields[1] == "kB" {
			val *= 1024
		}
		seen[key] = true
		switch key {
		case "MemTotal":
			m.Total = val
		case "MemFree":
			m.Free = val
		case "MemAvailable":
			m.Available, m.HasAvailable = val, true
		case "Buffers":
			m.Buffers = val
		case "Cached":
			m.Cached = val
		case "SReclaimable":
			m.SReclaimable = val
		case "Shmem":
			m.Shmem = val
		case "SwapTotal":
			m.SwapTotal = val
		case "SwapFree":
			m.SwapFree = val
		}
	}
	if err := sc.Err(); err != nil {
		return Meminfo{}, err
	}
	if !seen["MemTotal"] {
		return Meminfo{}, fmt.Errorf("parse meminfo: MemTotal missing")
	}
	return m, nil
}

// parseCPUModel extracts a human-readable model name from /proc/cpuinfo.
// x86 hosts use "model name"; ARM hosts often expose "Model" or "Hardware"
// instead. It never fails: unparseable/missing content yields "unknown".
func parseCPUModel(r io.Reader) string {
	values := map[string]string{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := sc.Text()
		colon := strings.IndexByte(line, ':')
		if colon <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:colon])
		val := strings.TrimSpace(line[colon+1:])
		if val == "" {
			continue
		}
		if _, ok := values[key]; !ok {
			values[key] = val
		}
	}
	// Priority: x86 model, then the ARM/dts model, then hardware fallbacks.
	for _, key := range []string{"model name", "Model", "Hardware", "Processor"} {
		if v := values[key]; v != "" {
			return v
		}
	}
	return "unknown"
}

// diskCounters are cumulative byte counters for one whole block device.
type diskCounters struct {
	read  uint64
	write uint64
}

// diskSectorSize is the fixed block size used by /proc/diskstats sector
// counters (Linux always reports 512-byte sectors, independent of the device's
// physical block size).
const diskSectorSize = 512

// parseDiskstats parses /proc/diskstats, keeping whole physical devices only.
// After the major/minor/device columns, sectors-read is the 3rd field and
// sectors-written the 7th (absolute 0-based indices 5 and 9).
func parseDiskstats(r io.Reader) (map[string]diskCounters, error) {
	out := map[string]diskCounters{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 10 {
			continue
		}
		device := fields[2]
		if !isWholeDisk(device) {
			continue
		}
		sectorsRead, err := strconv.ParseUint(fields[5], 10, 64)
		if err != nil {
			continue
		}
		sectorsWritten, err := strconv.ParseUint(fields[9], 10, 64)
		if err != nil {
			continue
		}
		out[device] = diskCounters{
			read:  sectorsRead * diskSectorSize,
			write: sectorsWritten * diskSectorSize,
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// isWholeDisk reports whether a /proc/diskstats device name is a whole
// physical disk rather than a partition or virtual/pseudo device.
func isWholeDisk(name string) bool {
	if strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "ram") ||
		strings.HasPrefix(name, "sr") || strings.HasPrefix(name, "dm-") {
		return false
	}
	if strings.HasPrefix(name, "nvme") {
		return isWholeNVMe(name)
	}
	if strings.HasPrefix(name, "mmcblk") {
		return allDigits(name[len("mmcblk"):])
	}
	for _, prefix := range []string{"xvd", "sd", "vd", "hd"} {
		if strings.HasPrefix(name, prefix) {
			return allLetters(name[len(prefix):])
		}
	}
	return false
}

// isWholeNVMe matches whole NVMe namespaces (nvme*n<digits>, e.g. nvme0n1 and
// nvme0c0n1) and rejects partitions such as nvme0n1p1.
func isWholeNVMe(name string) bool {
	rest := name[len("nvme"):]
	n := strings.LastIndexByte(rest, 'n')
	if n <= 0 || n == len(rest)-1 {
		return false
	}
	return allDigits(rest[n+1:])
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func allLetters(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < 'a' || r > 'z' {
			return false
		}
	}
	return true
}

// diskRate computes bytes/sec for one device between two samples. A counter
// that decreased (device reset/recreated) yields 0, never a negative spike.
func diskRate(prev diskCounters, cur diskCounters, elapsedSec float64) (readRate, writeRate *float64) {
	if elapsedSec <= 0 {
		return nil, nil
	}
	read := 0.0
	if cur.read >= prev.read {
		read = float64(cur.read-prev.read) / elapsedSec
	}
	write := 0.0
	if cur.write >= prev.write {
		write = float64(cur.write-prev.write) / elapsedSec
	}
	return &read, &write
}

// parseOperstate normalises /sys/class/net/<iface>/operstate to the wire
// contract values up/down/unknown.
func parseOperstate(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "up":
		return "up"
	case "down":
		return "down"
	default:
		return "unknown"
	}
}

// formatIPAddresses converts net.Addr values to CIDR-less IP strings, keeping
// both IPv4 and IPv6, deduplicated and deterministically sorted.
func formatIPAddresses(addrs []net.Addr) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		if addr == nil {
			continue
		}
		var ip net.IP
		switch v := addr.(type) {
		case *net.IPNet:
			ip = v.IP
		case *net.IPAddr:
			ip = v.IP
		default:
			continue
		}
		if ip == nil {
			continue
		}
		s := ip.String()
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

// cpuSample is the aggregate "cpu " row of /proc/stat: total jiffies across
// all buckets and idle jiffies (idle + iowait, which the kernel folds into
// idle accounting).
type cpuSample struct {
	total uint64
	idle  uint64
	ok    bool
}

// parseProcStat reads the aggregate cpu line (first line starting with "cpu ").
func parseProcStat(r io.Reader) (cpuSample, error) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)[1:]
		if len(fields) < 4 {
			return cpuSample{}, fmt.Errorf("parse stat: short cpu line")
		}
		var s cpuSample
		for i, f := range fields {
			v, err := strconv.ParseUint(f, 10, 64)
			if err != nil {
				return cpuSample{}, fmt.Errorf("parse stat: bad cpu field %d: %w", i, err)
			}
			s.total += v
			if i == 3 || i == 4 { // idle, iowait
				s.idle += v
			}
		}
		s.ok = true
		return s, nil
	}
	if err := sc.Err(); err != nil {
		return cpuSample{}, err
	}
	return cpuSample{}, fmt.Errorf("parse stat: aggregate cpu line not found")
}

// cpuPctBetween computes utilisation between two samples.
// ok is false when counters went backwards (hot-reset / wrap) or the delta is
// zero, in which case the caller should report cpuPct as null rather than a
// misleading 0.
func cpuPctBetween(a, b cpuSample) (float64, bool) {
	if !a.ok || !b.ok || b.total <= a.total {
		return 0, false
	}
	dt := b.total - a.total
	di := b.idle
	if b.idle >= a.idle {
		di = b.idle - a.idle
	} else {
		di = 0
	}
	if di > dt {
		di = dt
	}
	pct := (1 - float64(di)/float64(dt)) * 100
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return round2(pct), true
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
}

// netCounters are cumulative byte counters for one interface.
type netCounters struct {
	rx uint64
	tx uint64
}

// parseNetDev parses /proc/net/dev (rx bytes in field 0 after the colon, tx
// bytes in field 8). Loopback is parsed like any other interface so its
// operstate and addresses are reported honestly.
func parseNetDev(r io.Reader) (map[string]netCounters, error) {
	out := map[string]netCounters{}
	sc := bufio.NewScanner(r)
	for i := 0; sc.Scan(); i++ {
		if i < 2 { // two header lines
			continue
		}
		line := sc.Text()
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			continue
		}
		name := strings.TrimSpace(line[:colon])
		fields := strings.Fields(line[colon+1:])
		if name == "" || len(fields) < 9 {
			continue
		}
		rx, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		tx, err := strconv.ParseUint(fields[8], 10, 64)
		if err != nil {
			continue
		}
		out[name] = netCounters{rx: rx, tx: tx}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// netRate computes bytes/sec for one interface between two samples. A
// counter that decreased (reset, interface recreated) yields rate 0 instead of
// a negative spike.
func netRate(prev netCounters, cur netCounters, elapsedSec float64) (rxRate, txRate float64) {
	if elapsedSec <= 0 {
		return 0, 0
	}
	if cur.rx >= prev.rx {
		rxRate = float64(cur.rx-prev.rx) / elapsedSec
	}
	if cur.tx >= prev.tx {
		txRate = float64(cur.tx-prev.tx) / elapsedSec
	}
	return rxRate, txRate
}

// parseOsRelease parses /etc/os-release (or /usr/lib/os-release): KEY=value
// with optional surrounding quotes and minimal backslash unescaping.
func parseOsRelease(r io.Reader) (map[string]string, error) {
	out := map[string]string{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key := line[:eq]
		val := strings.TrimSpace(line[eq+1:])
		if len(val) >= 2 && ((val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'')) {
			val = val[1 : len(val)-1]
		}
		out[key] = strings.ReplaceAll(val, `\"`, `"`)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// OSInfo is the subset of os-release NexOPS needs.
type OSInfo struct {
	ID        string
	IDLike    string
	VersionID string
}

// DetectOS reads /etc/os-release (falling back to /usr/lib/os-release, the
// vendor-provided copy). Errors when neither file parses.
func DetectOS() (OSInfo, error) {
	for _, path := range []string{"/etc/os-release", "/usr/lib/os-release"} {
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		vals, err := parseOsRelease(f)
		f.Close()
		if err != nil {
			continue
		}
		return OSInfo{
			ID:        vals["ID"],
			IDLike:    vals["ID_LIKE"],
			VersionID: vals["VERSION_ID"],
		}, nil
	}
	return OSInfo{}, fmt.Errorf("os-release not found or unreadable")
}

// Family maps the os-release identity onto the control plane's OsFamily enum
// ("UBUNTU" | "DEBIAN"). Returns "" when the OS is not recognised, letting the
// caller fall back to the configured OS value.
func (o OSInfo) Family() string {
	for _, id := range []string{o.ID, o.IDLike} {
		switch strings.ToLower(id) {
		case "ubuntu":
			return "UBUNTU"
		case "debian":
			return "DEBIAN"
		}
	}
	return ""
}

// mountEntry is one /proc/mounts row.
type mountEntry struct {
	device     string
	mountPoint string
	fsType     string
}

// parseMounts parses /proc/mounts, decoding the octal escapes the kernel uses
// for whitespace in paths (\040 space, \011 tab, \012 newline, \134 backslash).
func parseMounts(r io.Reader) ([]mountEntry, error) {
	var out []mountEntry
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 3 {
			continue
		}
		out = append(out, mountEntry{
			device:     unescapeMount(fields[0]),
			mountPoint: unescapeMount(fields[1]),
			fsType:     fields[2],
		})
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	r := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)
	return r.Replace(s)
}

// physicalFS is the allowlist of filesystems reported as "disks". Pseudo
// filesystems (proc, sysfs, tmpfs, devtmpfs, cgroup, …) are excluded.
// overlay is included because containers (and some root installs) use it as
// the root filesystem.
var physicalFS = map[string]bool{
	"ext2": true, "ext3": true, "ext4": true,
	"xfs": true, "btrfs": true, "vfat": true, "exfat": true,
	"f2fs": true, "zfs": true, "erofs": true, "ntfs": true,
	"overlay": true,
}

// skipMountPrefixes are virtual trees whose statfs output is meaningless for
// capacity monitoring.
var skipMountPrefixes = []string{"/proc/", "/sys/", "/dev/", "/run/"}

// selectDisks filters raw mounts down to reportable physical mounts, skipping
// pseudo filesystems and virtual paths, deduplicating by backing device.
// overlay/none sources get no cross-mount dedupe because several distinct
// overlays can legitimately share the literal source name "overlay".
func selectDisks(mounts []mountEntry) []mountEntry {
	seen := make(map[string]bool, len(mounts))
	out := make([]mountEntry, 0, len(mounts))
	for _, m := range mounts {
		if !physicalFS[m.fsType] || m.device == "" {
			continue
		}
		if m.mountPoint != "/" && hasMountPrefix(m.mountPoint) {
			continue
		}
		key := m.device
		if m.device == "overlay" || m.device == "none" {
			key = m.mountPoint
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, m)
	}
	return out
}

func hasMountPrefix(mp string) bool {
	for _, p := range skipMountPrefixes {
		if strings.HasPrefix(mp+"/", p) {
			return true
		}
	}
	return false
}

// parseLoadavg extracts the 1/5/15-minute load averages.
func parseLoadavg(s string) (l1, l5, l15 float64, err error) {
	fields := strings.Fields(s)
	if len(fields) < 3 {
		return 0, 0, 0, fmt.Errorf("parse loadavg: want 3 fields, got %d", len(fields))
	}
	if l1, err = strconv.ParseFloat(fields[0], 64); err != nil {
		return
	}
	if l5, err = strconv.ParseFloat(fields[1], 64); err != nil {
		return
	}
	l15, err = strconv.ParseFloat(fields[2], 64)
	return
}

// parseUptime extracts seconds-since-boot from /proc/uptime.
func parseUptime(s string) (float64, error) {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return 0, fmt.Errorf("parse uptime: empty")
	}
	sec, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, fmt.Errorf("parse uptime: %w", err)
	}
	return sec, nil
}
