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

// Options wires the agent's dependencies (all injectable for tests).
type Options struct {
	Version   string
	Config    *config.Config
	State     *config.State
	Client    *protocol.Client
	Collector *metrics.Collector
	Runner    *jobs.Runner
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

// errReEnrolled signals that a rejected credential was replaced and the loop
// should poll again immediately instead of backing off.
var errReEnrolled = errors.New("credential re-enrolled")

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
}

func (a *loop) run(ctx context.Context) error {
	attempt := 0
	for {
		_, err := a.poll(ctx)
		switch {
		case err == nil:
			attempt = 0
			if sleepCtx(ctx, a.interval) != nil {
				return nil // shutdown
			}
		case errors.Is(err, errReEnrolled):
			// Fresh credential: poll again immediately with the
			// (possibly updated) enrolment interval.
			a.opts.Logger.Printf("re-enrolled; resuming heartbeats as agent %s (target %s)",
				a.opts.State.AgentID, a.opts.State.TargetID)
			a.interval = heartbeatInterval(a.opts)
			attempt = 0
		case ctx.Err() != nil:
			// Shutting down mid-poll: the result of any running job was
			// already attempted; stop cleanly.
			return nil
		default:
			var fatal fatalError
			if errors.As(err, &fatal) {
				return err
			}
			a.opts.Logger.Printf("heartbeat failed (attempt %d): %v", attempt+1, err)
			if sleepBackoff(ctx, attempt) != nil {
				return nil
			}
			attempt++
		}
	}
}

// poll performs one full heartbeat cycle: collect telemetry, POST it, run
// every dispatched job sequentially, report each result.
func (a *loop) poll(ctx context.Context) (int, error) {
	hb := a.opts.Collector.Collect(ctx)
	if ctx.Err() != nil {
		return 0, ctx.Err()
	}
	hb.AgentVersion = a.opts.Version

	resp, err := a.opts.Client.Heartbeat(ctx, a.opts.State.Credential, hb)
	if err != nil {
		if protocol.IsAuthError(err) {
			if a.opts.Config.EnrolToken == "" {
				return 0, fatalError{fmt.Errorf("credential rejected by control plane; re-enrol required — re-run the install command from the target's enrolment page (ENROL_TOKEN missing from %s)", a.opts.Config.EnvPath)}
			}
			a.opts.Logger.Printf("credential rejected by control plane (%v); clearing it and re-enrolling", err)
			if rerr := a.reEnrol(ctx); rerr != nil {
				return 0, rerr
			}
			return 0, errReEnrolled
		}
		return 0, err
	}

	ran := 0
	for _, job := range resp.Jobs {
		if ctx.Err() != nil {
			return ran, ctx.Err()
		}
		if job.IsTerminal() {
			// Cancelled between dispatch and receipt; the server already
			// knows — nothing to execute or report.
			a.opts.Logger.Printf("skipping job %s: already %s", job.ID, job.Status)
			continue
		}
		a.opts.Logger.Printf("job %s (%s) starting", job.ID, job.Type)
		result := a.opts.Runner.Run(ctx, job)
		a.opts.Logger.Printf("job %s finished: %s", job.ID, result.Status)
		if err := a.reportResult(ctx, job.ID, result); err != nil {
			// Do not proceed to the next job with an unreported terminal
			// state: the control plane would keep the job RUNNING and might
			// dispatch more while this one's outcome is lost.
			return ran, fmt.Errorf("report result for job %s: %w", job.ID, err)
		}
		ran++
	}
	return ran, nil
}

// reportResult retries until the control plane accepts the result, so a
// transient 5xx cannot lose a job's terminal state. During shutdown exactly
// one attempt is made (with a fresh context so the cancelled parent does not
// abort the POST). If the credential is rejected mid-flight the agent
// re-enrols once and retries; without an ENROL_TOKEN the result is dropped —
// losing one result is recoverable (the control plane times out stalled
// jobs), retrying forever with a revoked credential is not.
func (a *loop) reportResult(ctx context.Context, jobID string, result protocol.JobResultRequest) error {
	reEnrolled := false
	for attempt := 0; ; attempt++ {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), resultPostTimeout)
		err := a.opts.Client.JobResult(rctx, a.opts.State.Credential, jobID, result)
		cancel()
		if err == nil {
			return nil
		}
		if protocol.IsAuthError(err) {
			if reEnrolled || a.opts.Config.EnrolToken == "" {
				a.opts.Logger.Printf("result for job %s dropped: credential rejected by control plane and no re-enrol possible (%v)", jobID, err)
				return nil
			}
			a.opts.Logger.Printf("result post for job %s rejected (auth); re-enrolling and retrying once", jobID)
			if rerr := a.reEnrol(ctx); rerr != nil {
				return rerr
			}
			reEnrolled = true
			continue
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

// reEnrol clears the rejected credential (memory + state.json) and enrols
// again with the configured ENROL_TOKEN. Only called from the main loop —
// poll and reportResult run sequentially — so it can never race the job
// runner. key.pem is kept.
func (a *loop) reEnrol(ctx context.Context) error {
	a.opts.State.Credential = ""
	if err := config.SaveState(a.opts.Config.StateDir, *a.opts.State); err != nil {
		return fmt.Errorf("clear rejected credential from state: %w", err)
	}
	return enrolWithBackoff(ctx, a.opts)
}

// sleepCtx waits for d or until ctx is cancelled.
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
