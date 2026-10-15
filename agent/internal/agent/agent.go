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

	if err := enrolWithBackoff(ctx, o); err != nil {
		return err
	}
	interval := heartbeatInterval(o)
	o.Logger.Printf("enrolled as agent %s (target %s); heartbeat every %s",
		o.State.AgentID, o.State.TargetID, interval)

	a := &loop{opts: o}
	return a.run(ctx, interval)
}

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
	opts Options
}

func (a *loop) run(ctx context.Context, interval time.Duration) error {
	attempt := 0
	for {
		_, err := a.poll(ctx)
		switch {
		case err == nil:
			attempt = 0
			if sleepCtx(ctx, interval) != nil {
				return nil // shutdown
			}
		case ctx.Err() != nil:
			// Shutting down mid-poll: the result of any running job was
			// already attempted; stop cleanly.
			return nil
		default:
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
		var apiErr *protocol.APIError
		if errors.As(err, &apiErr) && apiErr.StatusCode == 401 {
			a.opts.Logger.Printf("control plane rejected the credential (401) — was this target revoked? retrying with backoff")
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
// abort the POST).
func (a *loop) reportResult(ctx context.Context, jobID string, result protocol.JobResultRequest) error {
	for attempt := 0; ; attempt++ {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), resultPostTimeout)
		err := a.opts.Client.JobResult(rctx, a.opts.State.Credential, jobID, result)
		cancel()
		if err == nil {
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
