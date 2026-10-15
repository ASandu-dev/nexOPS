package metrics

import (
	"context"
	"sync"
	"time"

	"github.com/nexops/agent/internal/protocol"
)

// cpuSampleWindow is how long the two /proc/stat samples are spaced. 400ms is
// long enough for meaningful jiffy deltas on even 100Hz kernels without
// noticeably delaying the heartbeat.
const cpuSampleWindow = 400 * time.Millisecond

// pkgCacheTTL bounds how often `apt-get -s upgrade` is simulated; it is
// expensive (full dependency resolution) and package availability does not
// change minute-to-minute.
const pkgCacheTTL = 10 * time.Minute

// pkgCache memoises the last package-update measurement. A nil val with a
// recent timestamp means "measured as unavailable" (cached too, so a host
// without apt is not probed on every heartbeat).
type pkgCache struct {
	at  time.Time
	val *protocol.PkgUpdateSummary
}

// Collector holds the cross-sample state (previous network counters, package
// update cache). One Collector per agent process; Collect is safe for
// sequential use.
type Collector struct {
	watched   []string
	prevNet   map[string]netCounters
	prevNetAt time.Time

	pkgMu sync.Mutex
	pkg   *pkgCache
}

// NewCollector creates a Collector watching the given systemd units.
func NewCollector(watchedServices []string) *Collector {
	return &Collector{watched: watchedServices}
}

// Collect samples the host and returns a HeartbeatRequest ready to POST.
//
// Collection is best-effort by design: a metric that cannot be read degrades
// to null (pointer fields) or an empty list rather than failing the whole
// heartbeat, because the control plane derives ONLINE/OFFLINE from heartbeat
// arrival, not from telemetry completeness. Hostname and AgentVersion are
// filled in by the caller.
func (c *Collector) Collect(ctx context.Context) protocol.HeartbeatRequest {
	return c.collect(ctx)
}
