//go:build linux

package metrics

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// TestCollectAggregatesCollectorErrors forces /proc/meminfo to fail while the
// other collectors keep working. The heartbeat must still carry the fields
// that were collected and name the failed collector in collectionErrors.
func TestCollectAggregatesCollectorErrors(t *testing.T) {
	files := map[string]string{
		"/proc/loadavg":              "0.10 0.20 0.30 1/100 1234\n",
		"/proc/mounts":               "",
		"/proc/net/dev":              "Inter-|   Receive |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n",
		"/proc/diskstats":            "",
		"/proc/cpuinfo":              "processor : 0\nmodel name : Test CPU @ 1.00GHz\n",
		"/etc/os-release":            "PRETTY_NAME=\"TestOS 1.0\"\nID=testos\n",
		"/proc/uptime":               "100.50 200.00\n",
		"/proc/sys/kernel/osrelease": "6.0.0-test\n",
	}

	statCalls := 0
	c := NewCollector(nil)
	c.readFile = func(path string) ([]byte, error) {
		if path == "/proc/stat" {
			statCalls++
			if statCalls == 1 {
				return []byte(procStat1), nil
			}
			return []byte(procStat2), nil
		}
		if path == "/proc/meminfo" {
			return nil, errors.New("synthetic read failure")
		}
		if body, ok := files[path]; ok {
			return []byte(body), nil
		}
		return nil, errors.New("not found")
	}

	hb := c.Collect(context.Background())

	if hb.CPUModel != "Test CPU @ 1.00GHz" {
		t.Fatalf("cpuModel = %q", hb.CPUModel)
	}
	if hb.OSPrettyName != "TestOS 1.0" {
		t.Fatalf("osPrettyName = %q", hb.OSPrettyName)
	}
	if hb.UptimeSec == nil || *hb.UptimeSec != 100 {
		t.Fatalf("uptimeSec = %v", hb.UptimeSec)
	}
	if hb.Kernel == nil || *hb.Kernel != "6.0.0-test" {
		t.Fatalf("kernel = %v", hb.Kernel)
	}
	// The failed collector leaves its fields at their zero/null defaults.
	if hb.MemTotalBytes != 0 || hb.SwapTotalBytes != nil || hb.SwapUsedBytes != nil {
		t.Fatalf("meminfo fields should be null/zero: %+v", hb)
	}
	if len(hb.CollectionErrors) != 1 {
		t.Fatalf("collectionErrors = %v, want exactly the meminfo failure", hb.CollectionErrors)
	}
	if !strings.HasPrefix(hb.CollectionErrors[0], "meminfo: ") {
		t.Fatalf("collectionErrors[0] = %q", hb.CollectionErrors[0])
	}
	// Unaffected slice fields stay non-nil so they marshal as [].
	if hb.Disks == nil || hb.DiskIO == nil || hb.Net == nil {
		t.Fatalf("slice fields must be non-nil: %+v", hb)
	}
}

func TestCollectDiskIORateAcrossSamples(t *testing.T) {
	const first = "   8       0 sda 100 0 2048 10 200 0 4096 20 0 0 0 0 0 0\n"
	const second = "   8       0 sda 110 0 4096 10 210 0 6144 20 0 0 0 0 0 0\n"

	reads := 0
	c := NewCollector(nil)
	c.readFile = func(path string) ([]byte, error) {
		if path != "/proc/diskstats" {
			return nil, errors.New("unexpected path")
		}
		reads++
		if reads == 1 {
			return []byte(first), nil
		}
		return []byte(second), nil
	}

	one, err := c.collectDiskIO()
	if err != nil {
		t.Fatal(err)
	}
	if len(one) != 1 || one[0].ReadRateBps != nil || one[0].WriteRateBps != nil {
		t.Fatalf("first sample = %+v, want null rates", one)
	}

	two, err := c.collectDiskIO()
	if err != nil {
		t.Fatal(err)
	}
	if len(two) != 1 {
		t.Fatalf("second sample = %+v", two)
	}
	if two[0].ReadRateBps == nil || two[0].WriteRateBps == nil {
		t.Fatal("second sample must carry rates")
	}
	if *two[0].ReadRateBps <= 0 || *two[0].WriteRateBps <= 0 {
		t.Fatalf("rates = %v/%v, want positive", *two[0].ReadRateBps, *two[0].WriteRateBps)
	}
}

func TestCollectNetIncludesLoopbackAndOperstate(t *testing.T) {
	c := NewCollector(nil)
	c.readFile = func(path string) ([]byte, error) {
		if path == "/proc/net/dev" {
			return []byte(netDevSample1), nil
		}
		// No sysfs fixtures: every interface honestly reports "unknown".
		return nil, errors.New("not found")
	}

	nets, err := c.collectNet()
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]string{}
	for _, n := range nets {
		byName[n.Name] = n.Operstate
		if n.IPs == nil {
			t.Fatalf("interface %s has nil ips; must be []", n.Name)
		}
	}
	for _, name := range []string{"lo", "eth0", "eth1"} {
		state, ok := byName[name]
		if !ok {
			t.Fatalf("interface %q missing from %v", name, byName)
		}
		if state != "unknown" {
			t.Fatalf("%s operstate = %q, want unknown fallback", name, state)
		}
	}
}
