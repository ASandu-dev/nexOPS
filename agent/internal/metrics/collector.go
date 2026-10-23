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

// pkgMeasureTimeout bounds a single background measurement so a SIGTERM aborts
// an in-flight apt run instead of leaving the refresher wedged at shutdown.
const pkgMeasureTimeout = 2 * time.Minute

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
	watched      []string
	prevNet      map[string]netCounters
	prevNetAt    time.Time
	prevDiskIO   map[string]diskCounters
	prevDiskIOAt time.Time

	pkgMu sync.Mutex
	pkg   *pkgCache

	// Injectables with safe production defaults (see NewCollector). measurePkg
	// is swapped by tests to avoid invoking apt; pkgTTL lets tests drive cache
	// expiry without waiting ten minutes. readFile is swapped by collection
	// tests; nil means os.ReadFile.
	measurePkg func(context.Context) *protocol.PkgUpdateSummary
	pkgTTL     time.Duration
	readFile   func(string) ([]byte, error)
	startOnce  sync.Once
}

// collectionErrors accumulates "<collector>: <error>" entries without ever
// failing the heartbeat. Telemetry is best-effort: callers keep whatever data
// the other collectors produced and report the failures alongside it.
type collectionErrors []string

func (e *collectionErrors) add(name string, err error) {
	if err == nil {
		return
	}
	*e = append(*e, name+": "+err.Error())
}

// NewCollector creates a Collector watching the given systemd units.
func NewCollector(watchedServices []string) *Collector {
	return &Collector{
		watched:    watchedServices,
		measurePkg: measurePkgUpdates,
		pkgTTL:     pkgCacheTTL,
	}
}

// Start launches the single background package-update refresher. It measures
// immediately, then re-measures on the TTL cadence, and stops when ctx is
// cancelled. Start is idempotent: repeated calls never launch a second
// goroutine, because two refreshers would run two apt simulations
// concurrently and double the host's load.
func (c *Collector) Start(ctx context.Context) {
	c.startOnce.Do(func() {
		go c.refreshPkgLoop(ctx)
	})
}

// refreshPkgLoop is the only writer of the package cache. Doing the measurement
// here, off the heartbeat path, keeps a multi-second apt simulation from
// delaying a beat. The single goroutine also guarantees refresh attempts never
// overlap: a measurement is always finished before the next timer is armed.
func (c *Collector) refreshPkgLoop(ctx context.Context) {
	for {
		c.refreshPkg(ctx)

		t := time.NewTimer(c.pkgTTL)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}

// refreshPkg measures once and stores the result. The mutex serialises the
// cache write against Collect's read.
func (c *Collector) refreshPkg(ctx context.Context) {
	mctx, cancel := context.WithTimeout(ctx, pkgMeasureTimeout)
	val := c.measurePkg(mctx)
	cancel()

	c.pkgMu.Lock()
	c.pkg = &pkgCache{at: time.Now(), val: val}
	c.pkgMu.Unlock()
}

// collectPkgUpdates reads the cache without ever measuring. It returns nil when
// nothing was measured within the TTL; on the wire `pkgUpdates == null` means
// "not measured within the last TTL", which is the honest contract for a value
// refreshed in the background at most once per TTL.
func (c *Collector) collectPkgUpdates() *protocol.PkgUpdateSummary {
	c.pkgMu.Lock()
	defer c.pkgMu.Unlock()
	if c.pkg == nil || time.Since(c.pkg.at) >= c.pkgTTL {
		return nil
	}
	return c.pkg.val
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
