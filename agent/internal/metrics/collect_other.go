//go:build !linux

package metrics

import (
	"context"
	"os"
	"runtime"
	"time"

	"github.com/nexops/agent/internal/protocol"
)

// collect is the stub for non-linux builds (development hosts). It reports
// only what the standard library can provide so the binary still boots and
// the control plane receives structurally valid heartbeats.
func (c *Collector) collect(ctx context.Context) protocol.HeartbeatRequest {
	_ = ctx
	hb := protocol.HeartbeatRequest{
		Disks:    []protocol.DiskUsage{},
		Net:      []protocol.NetInterface{},
		Services: []protocol.ServiceState{},
	}
	if n := runtime.NumCPU(); n > 0 {
		hb.Cores = &n
	}
	if h, err := os.Hostname(); err == nil {
		hb.Hostname = h
	}
	hb.CapturedAt = time.Now().UTC().Format(time.RFC3339)
	return hb
}

// measurePkgUpdates is the non-linux stub: package state is unavailable, so
// the background refresher stores nil and Collect reports pkgUpdates null.
func measurePkgUpdates(context.Context) *protocol.PkgUpdateSummary { return nil }
