package metrics

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nexops/agent/internal/protocol"
)

// TestCollectReadsPkgCacheWithoutBlocking proves package measurement never runs
// on the beat path: Collect returns while a measurement is still in flight and
// reports null, and the value appears once the background refresher finishes.
func TestCollectReadsPkgCacheWithoutBlocking(t *testing.T) {
	release := make(chan struct{})
	var calls int32

	c := NewCollector(nil)
	c.pkgTTL = 10 * time.Minute
	c.measurePkg = func(context.Context) *protocol.PkgUpdateSummary {
		atomic.AddInt32(&calls, 1)
		<-release
		return &protocol.PkgUpdateSummary{AvailableCount: 7}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.Start(ctx)

	type result struct{ hb protocol.HeartbeatRequest }
	done := make(chan result, 1)
	go func() { done <- result{c.Collect(ctx)} }()

	select {
	case r := <-done:
		if r.hb.PkgUpdates != nil {
			t.Fatalf("pkgUpdates = %+v, want nil while the measurement is in flight", r.hb.PkgUpdates)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Collect blocked on the in-flight package measurement")
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("measurement invocations = %d, want 1", got)
	}

	close(release)

	deadline := time.Now().Add(2 * time.Second)
	for {
		if hb := c.Collect(ctx); hb.PkgUpdates != nil {
			if hb.PkgUpdates.AvailableCount != 7 {
				t.Fatalf("availableCount = %d, want 7", hb.PkgUpdates.AvailableCount)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("cached package updates never became available after the refresh")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestCollectPkgUpdatesExpiredTTLReturnsNil pins the honest wire contract:
// pkgUpdates is null when the cached measurement is older than the TTL.
func TestCollectPkgUpdatesExpiredTTLReturnsNil(t *testing.T) {
	c := NewCollector(nil)
	c.pkgTTL = 50 * time.Millisecond
	c.pkgMu.Lock()
	c.pkg = &pkgCache{at: time.Now().Add(-time.Hour), val: &protocol.PkgUpdateSummary{AvailableCount: 3}}
	c.pkgMu.Unlock()

	if got := c.Collect(context.Background()).PkgUpdates; got != nil {
		t.Fatalf("pkgUpdates = %+v, want nil for an expired cache entry", got)
	}
}

// TestStartDoesNotDuplicateMeasurements proves Start is idempotent: a second
// call must not launch a second refresher (which would double apt load).
func TestStartDoesNotDuplicateMeasurements(t *testing.T) {
	var calls int32

	c := NewCollector(nil)
	c.pkgTTL = time.Hour
	c.measurePkg = func(context.Context) *protocol.PkgUpdateSummary {
		atomic.AddInt32(&calls, 1)
		return &protocol.PkgUpdateSummary{}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.Start(ctx)
	c.Start(ctx)

	deadline := time.Now().Add(2 * time.Second)
	for atomic.LoadInt32(&calls) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	// Give a would-be duplicate goroutine time to run before asserting.
	time.Sleep(50 * time.Millisecond)

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("measurement invocations = %d, want 1 (second Start must be a no-op)", got)
	}
}
