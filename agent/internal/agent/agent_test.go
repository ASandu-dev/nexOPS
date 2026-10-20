package agent

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nexops/agent/internal/config"
	"github.com/nexops/agent/internal/metrics"
	"github.com/nexops/agent/internal/protocol"
)

// fakeRunner blocks until its job context is cancelled, then reports CANCELLED.
// It lets the loop test exercise the cancel path without spawning a process.
type fakeRunner struct {
	started chan struct{}
	once    sync.Once
}

func newFakeRunner() *fakeRunner {
	return &fakeRunner{started: make(chan struct{})}
}

func (f *fakeRunner) Run(ctx context.Context, _ protocol.Job) protocol.JobResultRequest {
	f.once.Do(func() { close(f.started) })
	<-ctx.Done()
	now := time.Now().UTC().Format(time.RFC3339)
	return protocol.JobResultRequest{
		Status:     protocol.ResultCancelled,
		StartedAt:  &now,
		FinishedAt: &now,
	}
}

// TestLoopDeliversCancelToRunningJob proves the end-to-end agent contract: a
// job dispatched on one heartbeat is started by the worker, advertised back via
// activeJobIds, and killed when the next heartbeat returns it in
// cancelledJobIds — with a CANCELLED result reported to the control plane.
func TestLoopDeliversCancelToRunningJob(t *testing.T) {
	runner := newFakeRunner()

	var (
		mu            sync.Mutex
		heartbeats    int
		activeSeen    []string
		resultStatus  string
		resultArrived = make(chan struct{})
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == protocol.PathHearbeat:
			var req protocol.HeartbeatRequest
			_ = json.NewDecoder(r.Body).Decode(&req)

			mu.Lock()
			heartbeats++
			n := heartbeats
			activeSeen = append(activeSeen, req.ActiveJobIds...)
			mu.Unlock()

			if n == 1 {
				writeJSON(t, w, protocol.HeartbeatResponse{Jobs: []protocol.Job{{
					ID: "job-1", Type: protocol.JobServiceState, Status: "DISPATCHED", TimeoutSec: 600,
				}}})
				return
			}
			// Only cancel once the worker has actually started the job, so the
			// test exercises the running-job path rather than the pending skip.
			<-runner.started
			writeJSON(t, w, protocol.HeartbeatResponse{CancelledJobIds: []string{"job-1"}})

		case strings.HasSuffix(r.URL.Path, "/result"):
			body, _ := io.ReadAll(r.Body)
			var res protocol.JobResultRequest
			_ = json.Unmarshal(body, &res)
			mu.Lock()
			resultStatus = res.Status
			mu.Unlock()
			close(resultArrived)
			w.WriteHeader(http.StatusOK)

		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	client, err := protocol.NewClient(srv.URL)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	a := &loop{
		opts: Options{
			Version:   "test",
			Config:    &config.Config{ControlPlaneURL: srv.URL},
			State:     &config.State{Credential: "test-cred"},
			Client:    client,
			Collector: metrics.NewCollector(nil),
			Runner:    runner,
			Logger:    log.New(io.Discard, "", 0),
		},
		interval: 20 * time.Millisecond,
	}

	done := make(chan error, 1)
	go func() { done <- a.run(ctx) }()

	select {
	case <-resultArrived:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the cancelled job result")
	}

	mu.Lock()
	gotStatus := resultStatus
	seen := append([]string(nil), activeSeen...)
	mu.Unlock()

	if gotStatus != protocol.ResultCancelled {
		t.Fatalf("result status = %q, want %s", gotStatus, protocol.ResultCancelled)
	}
	if !contains(seen, "job-1") {
		t.Fatalf("heartbeat never advertised activeJobIds for the running job; saw %v", seen)
	}

	cancel()
	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("loop did not stop after context cancellation")
	}
}

// TestLoopHeartbeatsImmediately proves a freshly enrolled target does not wait
// a full interval before its first beat. The first heartbeat is what promotes
// PENDING_ENROLMENT to ONLINE and carries the first telemetry, so with the
// 1h interval used here a ticker-based loop would never beat within the test.
func TestLoopHeartbeatsImmediately(t *testing.T) {
	firstBeat := make(chan struct{})
	var once sync.Once

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != protocol.PathHearbeat {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		once.Do(func() { close(firstBeat) })
		writeJSON(t, w, protocol.HeartbeatResponse{})
	}))
	defer srv.Close()

	client, err := protocol.NewClient(srv.URL)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	a := &loop{
		opts: Options{
			Version:   "test",
			Config:    &config.Config{ControlPlaneURL: srv.URL},
			State:     &config.State{Credential: "test-cred"},
			Client:    client,
			Collector: metrics.NewCollector(nil),
			Runner:    newFakeRunner(),
			Logger:    log.New(io.Discard, "", 0),
		},
		interval: time.Hour,
	}

	go func() { _ = a.run(ctx) }()

	select {
	case <-firstBeat:
	case <-time.After(2 * time.Second):
		t.Fatal("no heartbeat within 2s despite an immediate first beat being required")
	}
	cancel()
}

func writeJSON(t *testing.T, w http.ResponseWriter, v any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		t.Errorf("encode response: %v", err)
	}
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
