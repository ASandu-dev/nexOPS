package agent

import (
	"context"
	"testing"
	"time"

	"github.com/nexops/agent/internal/protocol"
)

func TestJobQueueEnqueueAndNext(t *testing.T) {
	q := newJobQueue()
	q.enqueue(protocol.Job{ID: "a", Type: protocol.JobAPTUpdate})
	q.enqueue(protocol.Job{ID: "a", Type: protocol.JobAPTUpdate}) // duplicate ignored
	q.enqueue(protocol.Job{ID: "b", Type: protocol.JobAPTUpgrade})

	if got := q.activeIDs(); len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("activeIDs = %v, want [a b]", got)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	job, jctx, ok := q.next(ctx)
	if !ok || job.ID != "a" {
		t.Fatalf("next = (%q, %v), want job a", job.ID, ok)
	}
	if jctx.Err() != nil {
		t.Fatal("job context must be live")
	}
	// a is running, b is still pending: both count as active.
	if got := q.activeIDs(); len(got) != 2 {
		t.Fatalf("activeIDs = %v, want [a b]", got)
	}
	q.markDone("a")
	if got := q.activeIDs(); len(got) != 1 || got[0] != "b" {
		t.Fatalf("activeIDs = %v, want [b]", got)
	}
}

func TestJobQueueCancelPendingSkipsExecution(t *testing.T) {
	q := newJobQueue()
	q.enqueue(protocol.Job{ID: "a"})
	if !q.cancel("a") {
		t.Fatal("cancel of a pending job must report true")
	}
	if got := q.activeIDs(); len(got) != 0 {
		t.Fatalf("activeIDs = %v, want empty", got)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan bool, 1)
	go func() {
		_, _, ok := q.next(ctx)
		done <- ok
	}()
	// The cancelled job must never be handed to the worker.
	select {
	case ok := <-done:
		t.Fatalf("next returned %v; cancelled job must be skipped", ok)
	case <-time.After(100 * time.Millisecond):
	}
	cancel()
	if ok := <-done; ok {
		t.Fatal("next must return false once ctx is cancelled")
	}
}

func TestJobQueueCancelRunningCancelsContext(t *testing.T) {
	q := newJobQueue()
	q.enqueue(protocol.Job{ID: "a"})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	_, jctx, ok := q.next(ctx)
	if !ok {
		t.Fatal("next must return the pending job")
	}
	if !q.cancel("a") {
		t.Fatal("cancel of a running job must report true")
	}
	select {
	case <-jctx.Done():
	case <-time.After(time.Second):
		t.Fatal("running job context was not cancelled")
	}
}

func TestJobQueueCancelUnknownIsNoop(t *testing.T) {
	q := newJobQueue()
	if q.cancel("missing") {
		t.Fatal("cancel of an unknown job must report false")
	}
}
