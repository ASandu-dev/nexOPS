package agent

import (
	"context"
	"sort"
	"sync"

	"github.com/nexops/agent/internal/protocol"
)

// jobState tracks where an accepted job is in the agent's local pipeline.
type jobState int

const (
	jobPending   jobState = iota // accepted, waiting for the worker
	jobRunning                   // executing on the worker goroutine
	jobCancelled                 // cancelled before it started; never executed
)

// jobQueue is the agent's local, mutex-guarded view of the jobs it has
// accepted from the control plane. It exists so the heartbeat loop can keep
// beating — and receive cancel instructions — while a long job runs on the
// worker goroutine, and so each heartbeat can report exactly which jobs are
// "active" (running or accepted-but-unfinished).
//
// Every state transition happens under mu, so a cancel that races with the
// worker picking up a job resolves deterministically: the job is either still
// pending (marked cancelled and skipped) or already running (its context is
// cancelled, killing the process group).
type jobQueue struct {
	mu      sync.Mutex
	order   []string
	jobs    map[string]protocol.Job
	state   map[string]jobState
	cancels map[string]context.CancelFunc
	notify  chan struct{}
}

func newJobQueue() *jobQueue {
	return &jobQueue{
		jobs:    make(map[string]protocol.Job),
		state:   make(map[string]jobState),
		cancels: make(map[string]context.CancelFunc),
		notify:  make(chan struct{}, 1),
	}
}

// enqueue accepts a job unless it is already known (pending, running or
// cancelled). Duplicate dispatches are ignored.
func (q *jobQueue) enqueue(job protocol.Job) {
	q.mu.Lock()
	if _, known := q.state[job.ID]; known {
		q.mu.Unlock()
		return
	}
	q.jobs[job.ID] = job
	q.state[job.ID] = jobPending
	q.order = append(q.order, job.ID)
	q.mu.Unlock()
	q.signal()
}

// next blocks until a pending job is available or base is cancelled. It
// atomically marks the job running and registers its cancel func, so a
// concurrent cancel() can never miss it. Cancelled jobs are dropped without
// being executed.
func (q *jobQueue) next(base context.Context) (protocol.Job, context.Context, bool) {
	for {
		if base.Err() != nil {
			return protocol.Job{}, nil, false
		}

		q.mu.Lock()
		for len(q.order) > 0 {
			id := q.order[0]
			q.order = q.order[1:]
			switch q.state[id] {
			case jobPending:
				job := q.jobs[id]
				jctx, jcancel := context.WithCancel(base)
				q.state[id] = jobRunning
				q.cancels[id] = jcancel
				q.mu.Unlock()
				return job, jctx, true
			case jobCancelled:
				// Cancelled before it started: drop it, never execute.
				delete(q.state, id)
				delete(q.jobs, id)
			}
		}
		q.mu.Unlock()

		select {
		case <-base.Done():
			return protocol.Job{}, nil, false
		case <-q.notify:
		}
	}
}

// markDone forgets a finished job.
func (q *jobQueue) markDone(id string) {
	q.mu.Lock()
	delete(q.state, id)
	delete(q.jobs, id)
	delete(q.cancels, id)
	q.mu.Unlock()
}

// cancel aborts a job: a running job's context is cancelled (killing its
// process group), a pending job is marked cancelled so the worker skips it.
// Returns whether the job was known and non-terminal.
func (q *jobQueue) cancel(id string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	st, known := q.state[id]
	if !known {
		return false
	}
	switch st {
	case jobPending:
		q.state[id] = jobCancelled
		return true
	case jobRunning:
		if c := q.cancels[id]; c != nil {
			c()
		}
		return true
	}
	return false
}

// activeIDs returns the ids of jobs that are running or accepted-but-unfinished
// (pending), sorted for deterministic heartbeats.
func (q *jobQueue) activeIDs() []string {
	q.mu.Lock()
	defer q.mu.Unlock()
	ids := make([]string, 0, len(q.state))
	for id, st := range q.state {
		if st == jobPending || st == jobRunning {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

func (q *jobQueue) signal() {
	select {
	case q.notify <- struct{}{}:
	default:
	}
}
