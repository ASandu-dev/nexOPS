// Package agent is the main control loop: enrol on first start, then poll the
// control plane on a heartbeat interval, executing dispatched jobs
// sequentially and reporting results. The agent is outbound-only and never
// listens on a port.
package agent

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/nexops/agent/internal/config"
	"github.com/nexops/agent/internal/enrol"
	"github.com/nexops/agent/internal/jobs"
	"github.com/nexops/agent/internal/metrics"
	"github.com/nexops/agent/internal/protocol"
)

const (
	// backoffBase/backoffCap bound the retry delay after a failed
	// enrol/heartbeat/result call.
	backoffBase = 5 * time.Second
	backoffCap  = 5 * time.Minute
	// resultPostTimeout bounds a single result submission attempt.
	resultPostTimeout = 15 * time.Second
)

// jobRunner executes a single job and returns its wire result. *jobs.Runner is
// the production implementation; tests inject a fake so the loop can be driven
// without spawning real processes.
type jobRunner interface {
	Run(ctx context.Context, job protocol.Job) protocol.JobResultRequest
}

// Options wires the agent's dependencies (all injectable for tests).
type Options struct {
	Version   string
	Config    *config.Config
	State     *config.State
	Client    *protocol.Client
	Collector *metrics.Collector
	Runner    jobRunner
	Logger    *log.Logger
}

// Run blocks until ctx is cancelled (SIGTERM/SIGINT). If a job is executing
// during shutdown it is killed, and its result is still reported with a
// fresh, short-lived context so the control plane never keeps a job stuck in
// RUNNING after a clean stop.
func Run(ctx context.Context, o Options) error {
	if o.Logger == nil {
		o.Logger = log.Default()
	}
	if o.Runner == nil {
		o.Runner = jobs.NewRunner()
	}
	if o.Collector == nil {
		o.Collector = metrics.NewCollector(o.Config.WatchedServices)
	}

	// A credential issued by a different control plane (env file is
	// authoritative) is useless here: treat the host as freshly installed.
	// key.pem is deliberately kept — re-proving possession of the same key on
	// the new control plane is fine.
	if o.State.Credential != "" && !o.State.MatchesControlPlane(o.Config.ControlPlaneURL) {
		o.Logger.Printf("stored identity was issued by control plane %s, not %s — discarding it and re-enrolling",
			o.State.ControlPlaneURL, o.Config.ControlPlaneURL)
		*o.State = config.State{}
		if o.Config.EnrolToken == "" {
			return fmt.Errorf("identity belongs to a different control plane and cannot be re-enrolled: ENROL_TOKEN is missing from %s — re-run the install command from the target's enrolment page", o.Config.EnvPath)
		}
	}

	if err := enrolWithBackoff(ctx, o); err != nil {
		return err
	}
	interval := heartbeatInterval(o)
	o.Logger.Printf("enrolled as agent %s (target %s); heartbeat every %s",
		o.State.AgentID, o.State.TargetID, interval)

	a := &loop{opts: o, interval: interval}
	return a.run(ctx)
}

// fatalError wraps an unrecoverable condition (e.g. credential rejected and
// no ENROL_TOKEN to re-enrol with). The loop propagates it so the process
// exits non-zero; systemd's Restart= policy then backs off while the
// operator fixes the host.
type fatalError struct{ err error }

func (e fatalError) Error() string { return e.err.Error() }
func (e fatalError) Unwrap() error { return e.err }

// enrolWithBackoff retries enrolment until it succeeds or ctx is cancelled.
// A control plane that is briefly down at boot must not leave the host
// unmanaged forever.
func enrolWithBackoff(ctx context.Context, o Options) error {
	for attempt := 0; ; attempt++ {
		err := enrol.Ensure(ctx, o.Config, o.State, o.Client, o.Version)
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return fmt.Errorf("enrol aborted: %w", err)
		}
		o.Logger.Printf("enrol failed (attempt %d): %v; retrying", attempt+1, err)
		if err := sleepBackoff(ctx, attempt); err != nil {
			return fmt.Errorf("enrol aborted: %w", err)
		}
	}
}

// heartbeatInterval resolution: env override wins, then the value issued at
// enrolment, then the protocol default.
func heartbeatInterval(o Options) time.Duration {
	if o.Config.HeartbeatIntervalSec > 0 {
		return time.Duration(o.Config.HeartbeatIntervalSec) * time.Second
	}
	if o.State.HeartbeatIntervalSec > 0 {
		return time.Duration(o.State.HeartbeatIntervalSec) * time.Second
	}
	return config.DefaultHeartbeatIntervalSec * time.Second
}

type loop struct {
	opts     Options
	interval time.Duration

	// stateMu guards opts.State. The heartbeat loop writes it on re-enrolment
	// while the worker goroutine reads the credential to report results.
	stateMu sync.Mutex
}

func (a *loop) run(ctx context.Context) error {
	a.opts.Logger.Printf("agent loop starting; heartbeat every %s", a.interval)

	// runCtx is cancelled when the loop returns for any reason (shutdown or a
	// fatal error) so the worker's running job is killed and its result is
	// still reported before Run returns.
	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()

	q := newJobQueue()
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		a.worker(runCtx, q)
	}()
	defer func() {
		cancelRun()
		<-workerDone
	}()

	ticker := time.NewTicker(a.interval)
	defer ticker.Stop()

	attempt := 0
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			hb := a.opts.Collector.Collect(ctx)
			if ctx.Err() != nil {
				return nil
			}
			hb.AgentVersion = a.opts.Version
			hb.ActiveJobIds = q.activeIDs()

			resp, err := a.opts.Client.Heartbeat(ctx, a.credential(), hb)
			if err != nil {
				if protocol.IsAuthError(err) {
					if a.opts.Config.EnrolToken == "" {
						return fatalError{fmt.Errorf("credential rejected by control plane; re-enrol required — re-run the install command from the target's enrolment page (ENROL_TOKEN missing from %s)", a.opts.Config.EnvPath)}
					}
					a.opts.Logger.Printf("credential rejected by control plane (%v); clearing it and re-enrolling", err)
					if rerr := a.reEnrol(ctx); rerr != nil {
						return rerr
					}
					a.interval = heartbeatInterval(a.opts)
					ticker.Reset(a.interval)
					attempt = 0
					continue
				}
				var fatal fatalError
				if errors.As(err, &fatal) {
					return err
				}
				a.opts.Logger.Printf("heartbeat failed (attempt %d): %v", attempt+1, err)
				if sleepBackoff(ctx, attempt) != nil {
					return nil
				}
				attempt++
				continue
			}
			attempt = 0

			// Cancel instructions first: a job cancelled between dispatch and
			// this heartbeat must never be started.
			for _, id := range resp.CancelledJobIds {
				if q.cancel(id) {
					a.opts.Logger.Printf("job %s cancelled by operator", id)
				}
			}
			for _, job := range resp.Jobs {
				if job.IsTerminal() {
					a.opts.Logger.Printf("skipping job %s: already %s", job.ID, job.Status)
					continue
				}
				q.enqueue(job)
			}
		}
	}
}

// worker consumes accepted jobs strictly sequentially. It runs on its own
// goroutine so the heartbeat loop keeps beating — and can deliver cancels —
// while a long job executes.
func (a *loop) worker(ctx context.Context, q *jobQueue) {
	for {
		job, jctx, ok := q.next(ctx)
		if !ok {
			return
		}
		a.opts.Logger.Printf("job %s (%s) starting", job.ID, job.Type)
		result := a.opts.Runner.Run(jctx, job)
		q.markDone(job.ID)
		if err := a.reportResult(ctx, job.ID, result); err != nil {
			a.opts.Logger.Printf("report result for job %s failed: %v", job.ID, err)
		}
	}
}

// credential returns the current bearer credential under stateMu.
func (a *loop) credential() string {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	return a.opts.State.Credential
}

// reportResult retries until the control plane accepts the result, so a
// transient 5xx cannot lose a job's terminal state. During shutdown exactly
// one attempt is made (with a fresh context so the cancelled parent does not
// abort the POST). A rejected credential is not re-enrolled here: the
// heartbeat loop owns re-enrolment, and racing it would consume the
// single-use token twice. Losing one result is recoverable — the control
// plane times out stalled jobs.
func (a *loop) reportResult(ctx context.Context, jobID string, result protocol.JobResultRequest) error {
	for attempt := 0; ; attempt++ {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), resultPostTimeout)
		err := a.opts.Client.JobResult(rctx, a.credential(), jobID, result)
		cancel()
		if err == nil {
			return nil
		}
		if protocol.IsAuthError(err) {
			a.opts.Logger.Printf("result for job %s dropped: credential rejected by control plane (%v)", jobID, err)
			return nil
		}
		if ctx.Err() != nil {
			// Already used our one shutdown attempt.
			a.opts.Logger.Printf("result for job %s not accepted (shutting down): %v", jobID, err)
			return err
		}
		a.opts.Logger.Printf("result post for job %s failed (attempt %d): %v", jobID, attempt+1, err)
		if err := sleepBackoff(ctx, attempt); err != nil {
			return err
		}
	}
}

// reEnrol clears the rejected credential and enrols again. It is only called
// from the heartbeat loop; stateMu serialises the State write against the
// worker's credential reads.
func (a *loop) reEnrol(ctx context.Context) error {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	a.opts.State.Credential = ""
	if err := config.SaveState(a.opts.Config.StateDir, *a.opts.State); err != nil {
		return fmt.Errorf("clear stored credential: %w", err)
	}
	return enrolWithBackoff(ctx, a.opts)
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// sleepBackoff waits min(base*2^attempt, cap), aborting on ctx cancellation.
func sleepBackoff(ctx context.Context, attempt int) error {
	d := backoffBase << attempt
	if d <= 0 || d > backoffCap {
		d = backoffCap
	}
	return sleepCtx(ctx, d)
}
