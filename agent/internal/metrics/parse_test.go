package metrics

import (
	"math"
	"net"
	"reflect"
	"strings"
	"testing"
)

const meminfoWithAvailable = `MemTotal:       16324356 kB
MemFree:        12000000 kB
MemAvailable:   13000000 kB
Buffers:          200000 kB
Cached:          1500000 kB
SwapCached:            0 kB
Active:          3000000 kB
Inactive:        1200000 kB
SwapTotal:       2097148 kB
SwapFree:        2097148 kB
Dirty:               100 kB
Shmem:            100000 kB
SReclaimable:     150000 kB
SUnreclaim:       100000 kB
Slab:             250000 kB
`

func TestParseMeminfoWithMemAvailable(t *testing.T) {
	m, err := parseMeminfo(strings.NewReader(meminfoWithAvailable))
	if err != nil {
		t.Fatal(err)
	}
	if m.Total != 16324356*1024 {
		t.Fatalf("total = %d", m.Total)
	}
	// MemAvailable must be preferred over MemFree-based math.
	if got := m.MemAvailableBytes(); got != 13000000*1024 {
		t.Fatalf("available = %d, want MemAvailable", got)
	}
	// used = total − available.
	wantUsed := uint64((16324356 - 13000000) * 1024)
	if got := m.MemUsedBytes(); got != wantUsed {
		t.Fatalf("used = %d, want %d", got, wantUsed)
	}
	// No swap in use.
	if got := m.SwapUsedBytes(); got != 0 {
		t.Fatalf("swapUsed = %d", got)
	}
}

const meminfoWithoutAvailable = `MemTotal:       1000000 kB
MemFree:         200000 kB
Buffers:          50000 kB
Cached:          400000 kB
SwapTotal:       500000 kB
SwapFree:        300000 kB
Shmem:           100000 kB
SReclaimable:     50000 kB
`

func TestParseMeminfoFallbackAvailable(t *testing.T) {
	m, err := parseMeminfo(strings.NewReader(meminfoWithoutAvailable))
	if err != nil {
		t.Fatal(err)
	}
	if m.HasAvailable {
		t.Fatal("HasAvailable should be false")
	}
	// Fallback: Free + Buffers + Cached + SReclaimable − Shmem
	//        = 200000 + 50000 + 400000 + 50000 − 100000 = 600000 kB
	if got := m.MemAvailableBytes(); got != 600000*1024 {
		t.Fatalf("fallback available = %d, want %d", got, 600000*1024)
	}
	if got := m.SwapUsedBytes(); got != 200000*1024 {
		t.Fatalf("swapUsed = %d, want %d", got, 200000*1024)
	}
}

func TestParseMeminfoRejectsGarbage(t *testing.T) {
	if _, err := parseMeminfo(strings.NewReader("nonsense\n")); err == nil {
		t.Fatal("expected error when MemTotal is missing")
	}
}

const procStat1 = `cpu  100 0 100 700 100 0 0 0 0 0
cpu0 50 0 50 350 50 0 0 0 0 0
intr 12345
ctxt 6789
`

// total delta = 200, idle+iowait delta = 100 → 50% utilisation.
const procStat2 = `cpu  150 0 150 750 150 0 0 0 0 0
cpu0 75 0 75 375 75 0 0 0 0 0
`

func TestParseProcStatAndCPUDelta(t *testing.T) {
	s1, err := parseProcStat(strings.NewReader(procStat1))
	if err != nil {
		t.Fatal(err)
	}
	s2, err := parseProcStat(strings.NewReader(procStat2))
	if err != nil {
		t.Fatal(err)
	}
	// Sample 1: total = 1000, idle = 700+100 = 800.
	if s1.total != 1000 || s1.idle != 800 {
		t.Fatalf("sample1 = %+v", s1)
	}
	pct, ok := cpuPctBetween(s1, s2)
	if !ok {
		t.Fatal("expected ok")
	}
	// delta total = 200, delta idle = 100 → 50%.
	if math.Abs(pct-50.0) > 0.01 {
		t.Fatalf("pct = %v, want 50", pct)
	}
}

func TestCPUPctRejectsCounterReset(t *testing.T) {
	a := cpuSample{total: 2000, idle: 1000, ok: true}
	b := cpuSample{total: 1000, idle: 500, ok: true}
	if _, ok := cpuPctBetween(a, b); ok {
		t.Fatal("counter decrease must not produce a reading")
	}
	if _, ok := cpuPctBetween(a, a); ok {
		t.Fatal("zero delta must not produce a reading")
	}
	if _, ok := cpuPctBetween(cpuSample{}, b); ok {
		t.Fatal("bad first sample must not produce a reading")
	}
}

func TestCPUPctClamped(t *testing.T) {
	a := cpuSample{total: 100, idle: 100, ok: true}
	b := cpuSample{total: 200, idle: 100, ok: true} // idle delta 0 → 100%
	pct, ok := cpuPctBetween(a, b)
	if !ok || pct != 100 {
		t.Fatalf("pct = %v ok=%v, want 100", pct, ok)
	}
	// Idle increased more than total (shouldn't happen) → clamp at 0.
	c := cpuSample{total: 300, idle: 250, ok: true}
	pct, ok = cpuPctBetween(b, c)
	if !ok || pct != 0 {
		t.Fatalf("pct = %v ok=%v, want 0", pct, ok)
	}
}

const netDevSample1 = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000    10    0    0    0     0          0         0     1000    10    0    0    0     0       0          0
  eth0: 10000   20    0    0    0     0          0         0     5000    15    0    0    0     0       0          0
  eth1:  7000   12    0    0    0     0          0         0     3000    11    0    0    0     0       0          0
`

// +2000 rx / +1000 tx on eth0; eth1 counters went DOWN (reset).
const netDevSample2 = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1100    11    0    0    0     0          0         0     1100    11    0    0    0     0       0          0
  eth0: 12000   25    0    0    0     0          0         0     6000    20    0    0    0     0       0          0
  eth1:  1000    2    0    0    0     0          0         0      500     1    0    0    0     0       0          0
`

func TestParseNetDevRatesAndReset(t *testing.T) {
	prev, err := parseNetDev(strings.NewReader(netDevSample1))
	if err != nil {
		t.Fatal(err)
	}
	if len(prev) != 3 {
		t.Fatalf("expected 3 interfaces, got %d", len(prev))
	}
	if prev["eth0"].rx != 10000 || prev["eth0"].tx != 5000 {
		t.Fatalf("eth0 = %+v", prev["eth0"])
	}
	cur, err := parseNetDev(strings.NewReader(netDevSample2))
	if err != nil {
		t.Fatal(err)
	}
	// 2 seconds elapsed → eth0: 2000/2 = 1000 rx, 1000/2 = 500 tx.
	rx, tx := netRate(prev["eth0"], cur["eth0"], 2.0)
	if rx != 1000 || tx != 500 {
		t.Fatalf("eth0 rates = %v/%v, want 1000/500", rx, tx)
	}
	// eth1 reset: counters decreased → both rates 0, never negative.
	rx, tx = netRate(prev["eth1"], cur["eth1"], 2.0)
	if rx != 0 || tx != 0 {
		t.Fatalf("eth1 reset rates = %v/%v, want 0/0", rx, tx)
	}
	// Zero elapsed (first sample) → 0.
	rx, tx = netRate(prev["eth0"], cur["eth0"], 0)
	if rx != 0 || tx != 0 {
		t.Fatalf("zero elapsed rates = %v/%v", rx, tx)
	}
}

const osReleaseUbuntu = `NAME="Ubuntu"
VERSION="24.04.1 LTS (Noble Numbat)"
ID=ubuntu
ID_LIKE=debian
PRETTY_NAME="Ubuntu 24.04.1 LTS"
VERSION_ID="24.04"
`

func TestParseOsRelease(t *testing.T) {
	vals, err := parseOsRelease(strings.NewReader(osReleaseUbuntu))
	if err != nil {
		t.Fatal(err)
	}
	if vals["ID"] != "ubuntu" || vals["VERSION_ID"] != "24.04" {
		t.Fatalf("vals = %v", vals)
	}
	if vals["PRETTY_NAME"] != "Ubuntu 24.04.1 LTS" {
		t.Fatalf("PRETTY_NAME quoting not stripped: %q", vals["PRETTY_NAME"])
	}
	info := OSInfo{ID: vals["ID"], IDLike: vals["ID_LIKE"], VersionID: vals["VERSION_ID"]}
	if info.Family() != "UBUNTU" {
		t.Fatalf("family = %q", info.Family())
	}
	if got := (OSInfo{ID: "debian"}).Family(); got != "DEBIAN" {
		t.Fatalf("family = %q", got)
	}
	if got := (OSInfo{ID: "fedora", IDLike: "debian"}).Family(); got != "DEBIAN" {
		t.Fatalf("ID_LIKE fallback = %q", got)
	}
	if got := (OSInfo{ID: "arch"}).Family(); got != "" {
		t.Fatalf("unknown family = %q", got)
	}
}

const mountsSample = `proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0
devtmpfs /dev devtmpfs rw,nosuid,size=16171428k,nr_inodes=4042857,mode=755 0 0
tmpfs /run tmpfs rw,nosuid,nodev,noexec,size=3236216k,mode=755 0 0
/dev/sda2 / ext4 rw,relatime 0 0
/dev/sda1 /boot/efi vfat rw,relatime,fmask=0077,dmask=0077,utf8,shortname=winnt 0 0
/dev/sdb1 /var/lib/data xfs rw,noatime 0 0
/dev/sdb1 /srv/data-bind xfs rw,noatime 0 0
overlay /var/lib/docker/overlay2/abc/merged overlay rw,lowerdir=... 0 0
tmpfs /tmp/foo tmpfs rw 0 0
`

func TestParseMounts(t *testing.T) {
	mounts, err := parseMounts(strings.NewReader(mountsSample))
	if err != nil {
		t.Fatal(err)
	}
	if len(mounts) != 10 {
		t.Fatalf("parsed %d mounts, want 10", len(mounts))
	}
	if mounts[4].device != "/dev/sda2" || mounts[4].mountPoint != "/" || mounts[4].fsType != "ext4" {
		t.Fatalf("root entry wrong: %+v", mounts[4])
	}
}

func TestParseMountsUnescapesSpaces(t *testing.T) {
	mounts, err := parseMounts(strings.NewReader(`/dev/sda3 /mnt/my\040disk ext4 rw 0 0`))
	if err != nil {
		t.Fatal(err)
	}
	if mounts[0].mountPoint != "/mnt/my disk" {
		t.Fatalf("mountPoint = %q", mounts[0].mountPoint)
	}
}

func TestSelectDisksFiltersAndDedupes(t *testing.T) {
	mounts, err := parseMounts(strings.NewReader(mountsSample))
	if err != nil {
		t.Fatal(err)
	}
	sel := selectDisks(mounts)

	got := map[string]string{}
	for _, m := range sel {
		got[m.mountPoint] = m.fsType
	}
	// Pseudo filesystems excluded.
	for _, mp := range []string{"/proc", "/sys", "/dev", "/run", "/tmp/foo"} {
		if _, ok := got[mp]; ok {
			t.Errorf("pseudo mount %s (%s) should be excluded", mp, got[mp])
		}
	}
	// Physical + overlay root kept.
	if got["/"] != "ext4" {
		t.Errorf("/ = %q, want ext4", got["/"])
	}
	if got["/boot/efi"] != "vfat" {
		t.Errorf("/boot/efi = %q", got["/boot/efi"])
	}
	if got["/var/lib/docker/overlay2/abc/merged"] != "overlay" {
		t.Errorf("overlay mount missing: %v", got)
	}
	// Same device mounted twice → deduped to one entry.
	if _, ok := got["/srv/data-bind"]; ok {
		t.Errorf("bind mount of /dev/sdb1 should be deduped by device")
	}
	if got["/var/lib/data"] != "xfs" {
		t.Errorf("/var/lib/data = %q", got["/var/lib/data"])
	}
	if len(sel) != 4 {
		t.Errorf("selected %d disks, want 4: %+v", len(sel), sel)
	}
}

func TestParseLoadavg(t *testing.T) {
	l1, l5, l15, err := parseLoadavg("0.42 0.35 0.30 1/345 12345\n")
	if err != nil {
		t.Fatal(err)
	}
	if l1 != 0.42 || l5 != 0.35 || l15 != 0.30 {
		t.Fatalf("load = %v %v %v", l1, l5, l15)
	}
	if _, _, _, err := parseLoadavg("bad"); err == nil {
		t.Fatal("expected error")
	}
}

func TestParseUptime(t *testing.T) {
	up, err := parseUptime("12345.67 23456.78\n")
	if err != nil {
		t.Fatal(err)
	}
	if up != 12345.67 {
		t.Fatalf("uptime = %v", up)
	}
	if _, err := parseUptime(""); err == nil {
		t.Fatal("expected error")
	}
}

func TestParseCPUModel(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "amd64 model name",
			in: `processor : 0
vendor_id : GenuineIntel
model name : Intel(R) Xeon(R) CPU E5-2670 v3 @ 2.30GHz
flags : fpu
`,
			want: "Intel(R) Xeon(R) CPU E5-2670 v3 @ 2.30GHz",
		},
		{
			name: "arm model preferred over hardware",
			in: `processor : 0
Hardware : BCM2711
Model : Raspberry Pi 4 Model B Rev 1.4
`,
			want: "Raspberry Pi 4 Model B Rev 1.4",
		},
		{
			name: "arm hardware fallback",
			in: `processor : 0
Hardware : BCM2835
`,
			want: "BCM2835",
		},
		{
			name: "missing",
			in:   "processor : 0\n",
			want: "unknown",
		},
		{
			name: "empty",
			want: "unknown",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseCPUModel(strings.NewReader(tc.in)); got != tc.want {
				t.Fatalf("parseCPUModel = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestParseMeminfoSwapTotal(t *testing.T) {
	m, err := parseMeminfo(strings.NewReader(meminfoWithAvailable))
	if err != nil {
		t.Fatal(err)
	}
	if m.SwapTotal != 2097148*1024 {
		t.Fatalf("swap total = %d, want %d", m.SwapTotal, 2097148*1024)
	}
}

const diskstatsSample = `   8       0 sda 100 0 2048 10 200 0 4096 20 0 0 0 0 0 0
   8       1 sda1 10 0 512 1 20 0 512 2 0 0 0 0 0 0
   8      16 sdb 5 0 1024 5 6 0 2048 6 0 0 0 0 0 0
 259       0 nvme0n1 7 0 3072 7 8 0 1024 8 0 0 0 0 0 0
 259       1 nvme0n1p1 7 0 4000 7 8 0 5000 8 0 0 0 0 0 0
 259       2 nvme0c0n1 2 0 1024 2 3 0 2048 3 0 0 0 0 0 0
 259       3 nvme0c0n1p1 2 0 3000 2 3 0 3500 3 0 0 0 0 0 0
 179       0 mmcblk0 9 0 2048 9 10 0 4096 10 0 0 0 0 0 0
 179       1 mmcblk0p1 9 0 3000 9 10 0 3500 10 0 0 0 0 0 0
   7       0 loop0 1 0 8 0 2 0 16 0 0 0 0 0 0 0
   1       0 ram0 1 0 8 0 2 0 16 0 0 0 0 0 0 0
  11       0 sr0 1 0 8 0 2 0 16 0 0 0 0 0 0 0
 253       0 dm-0 1 0 8 0 2 0 16 0 0 0 0 0 0 0
 202       0 xvda 3 0 512 3 4 0 1024 4 0 0 0 0 0 0
 252       0 vda 3 0 512 3 4 0 1024 4 0 0 0 0 0 0
   3       0 hda 3 0 512 3 4 0 1024 4 0 0 0 0 0 0
`

func TestParseDiskstatsFiltersAndConvertsSectors(t *testing.T) {
	stats, err := parseDiskstats(strings.NewReader(diskstatsSample))
	if err != nil {
		t.Fatal(err)
	}
	wantDevices := []string{"hda", "mmcblk0", "nvme0c0n1", "nvme0n1", "sda", "sdb", "vda", "xvda"}
	if len(stats) != len(wantDevices) {
		t.Fatalf("devices = %v, want %v", stats, wantDevices)
	}
	for _, device := range wantDevices {
		if _, ok := stats[device]; !ok {
			t.Errorf("missing whole device %q", device)
		}
	}
	for _, device := range []string{"sda1", "nvme0n1p1", "nvme0c0n1p1", "mmcblk0p1", "loop0", "ram0", "sr0", "dm-0"} {
		if _, ok := stats[device]; ok {
			t.Errorf("partition/pseudo device %q should be filtered", device)
		}
	}
	if got := stats["sda"]; got.read != 2048*512 || got.write != 4096*512 {
		t.Fatalf("sda counters = %+v", got)
	}
	if got := stats["nvme0n1"]; got.read != 3072*512 || got.write != 1024*512 {
		t.Fatalf("nvme0n1 counters = %+v", got)
	}
}

func TestDiskRateFromTwoSamples(t *testing.T) {
	prev := diskCounters{read: 1024, write: 2048}
	cur := diskCounters{read: 5120, write: 6144}

	read, write := diskRate(prev, cur, 2)
	if read == nil || write == nil {
		t.Fatal("expected rates for a valid previous sample")
	}
	if *read != 2048 || *write != 2048 {
		t.Fatalf("rates = %v/%v, want 2048/2048", *read, *write)
	}

	// Counter reset: never negative.
	reset := diskCounters{read: 100, write: 100}
	read, write = diskRate(prev, reset, 1)
	if read == nil || write == nil || *read != 0 || *write != 0 {
		t.Fatalf("reset rates = %v/%v, want 0/0", read, write)
	}

	// No elapsed time (first sample): no rate at all.
	if read, write = diskRate(prev, cur, 0); read != nil || write != nil {
		t.Fatalf("zero elapsed rates = %v/%v, want nil/nil", read, write)
	}
}

func TestParseCPUMissingOsReleaseKey(t *testing.T) {
	vals, err := parseOsRelease(strings.NewReader("NAME=\"Debian\"\nID=debian\n"))
	if err != nil {
		t.Fatal(err)
	}
	if vals["PRETTY_NAME"] != "" {
		t.Fatalf("PRETTY_NAME = %q, want empty", vals["PRETTY_NAME"])
	}
}

func TestParseOperstate(t *testing.T) {
	cases := map[string]string{
		"up\n":       "up",
		"down\n":     "down",
		" unknown\n": "unknown",
		"dormant\n":  "unknown",
		"":           "unknown",
		"UP\n":       "up",
	}
	for in, want := range cases {
		if got := parseOperstate(in); got != want {
			t.Errorf("parseOperstate(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFormatIPAddresses(t *testing.T) {
	v4ip, _, _ := net.ParseCIDR("192.0.2.10/24")
	v6ip, _, _ := net.ParseCIDR("2001:db8::5/64")
	v4net := &net.IPNet{IP: v4ip, Mask: net.CIDRMask(24, 32)}
	v6net := &net.IPNet{IP: v6ip, Mask: net.CIDRMask(64, 128)}
	addrs := []net.Addr{
		v4net,
		v6net,
		&net.IPAddr{IP: net.ParseIP("198.51.100.7")},
		v4net, // duplicate
	}
	got := formatIPAddresses(addrs)
	want := []string{"192.0.2.10", "198.51.100.7", "2001:db8::5"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("formatIPAddresses = %v, want %v", got, want)
	}
	if got := formatIPAddresses(nil); got == nil || len(got) != 0 {
		t.Fatalf("nil addrs should produce a non-nil empty slice, got %v", got)
	}
}
