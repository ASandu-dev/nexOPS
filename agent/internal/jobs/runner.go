// Package jobs executes dispatched control-plane jobs. Execution is strictly
// sequential (one job at a time) and every process runs under a timeout with
// its stdout/stderr captured into capped tail buffers. Nothing is executed
// through a shell, so parameters can never be interpreted as shell syntax.
package jobs

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/nexops/agent/internal/apt"
	"github.com/nexops/agent/internal/protocol"
	"github.com/nexops/agent/internal/units"
)

// TailCapBytes is the maximum number of trailing stdout/stderr bytes reported
// to the control plane (the head is discarded, the tail is what matters for
// apt/diagnostic output).
const TailCapBytes = 64 * 1024

// waitDelay bounds how long exec waits for I/O pipes after the process is
// killed, so a killed apt child holding the pipe cannot stall the agent.
const waitDelay = 5 * time.Second

// Runner executes jobs. TailBytes caps reported output; NewRunner applies
// TailCapBytes.
type Runner struct {
	TailBytes int
}

// NewRunner returns a Runner with the default tail cap.
func NewRunner() *Runner {
	return &Runner{TailBytes: TailCapBytes}
}

// cmdSpec is an argv vector plus extra environment assignments — never a
// shell string.
type cmdSpec struct {
	name string
	args []string
	env  []string
}

// Run executes one job and produces the wire result. It never returns an
// error: failures (unknown type, invalid params, non-zero exit, timeout) are
// reported through the result status so the control plane always receives a
// terminal state.
func (r *Runner) Run(ctx context.Context, job protocol.Job) protocol.JobResultRequest {
	started := time.Now().UTC()

	spec, err := buildSpec(job)
	if err != nil {
		// Validation failure: no process ran, so exitCode stays null.
		finished := time.Now().UTC()
		return protocol.JobResultRequest{
			Status:     protocol.ResultFailed,
			ExitCode:   nil,
			StdoutTail: strPtr(""),
			StderrTail: strPtr(err.Error() + "\n"),
			StartedAt:  strPtr(started.Format(time.RFC3339)),
			FinishedAt: strPtr(finished.Format(time.RFC3339)),
		}
	}

	timeout := job.Timeout()
	res := r.exec(ctx, spec, timeout)
	return resultFrom(res, timeout, started)
}

// resultFrom maps an exec outcome onto the wire result. A timeout is reported
// as TIMED_OUT (matching ARCHITECTURE.md §3); the control plane's own watchdog
// transitions jobs the same way if the agent never reports back.
func resultFrom(res execResult, timeout time.Duration, started time.Time) protocol.JobResultRequest {
	status := protocol.ResultSucceeded
	if res.timedOut {
		status = protocol.ResultTimedOut
	} else if res.err != nil {
		status = protocol.ResultFailed
	}
	stderr := res.stderr
	if res.timedOut {
		stderr = appendNote(stderr, fmt.Sprintf("nexops-agent: job timed out after %s and was killed", timeout))
	} else if res.startErr != nil {
		stderr = appendNote(stderr, "nexops-agent: "+res.startErr.Error())
	}
	finished := time.Now().UTC()
	return protocol.JobResultRequest{
		Status:     status,
		ExitCode:   intPtr(res.exitCode),
		StdoutTail: strPtr(res.stdout),
		StderrTail: strPtr(stderr),
		StartedAt:  strPtr(started.Format(time.RFC3339)),
		FinishedAt: strPtr(finished.Format(time.RFC3339)),
	}
}

// buildSpec translates the job DTO into an argv vector, validating every
// parameter that reaches the command line. Apt maintenance goes through
// apt.SpecFor (sudoers helper on hosts, direct apt-get in dev/containers);
// SERVICE_STATUS stays a plain unprivileged systemctl call.
func buildSpec(job protocol.Job) (cmdSpec, error) {
	return buildSpecWith(job, apt.SpecFor)
}

// buildSpecWith takes the apt spec resolver so tests can pin the routing
// deterministically; production always passes apt.SpecFor.
func buildSpecWith(job protocol.Job, aptSpec func(apt.Sub) (apt.Spec, error)) (cmdSpec, error) {
	switch job.Type {
	case protocol.JobAPTUpdate, protocol.JobAPTUpgrade, protocol.JobAPTFixBroken, protocol.JobCheckUpdates:
		sub, err := aptSubForJob(job.Type)
		if err != nil {
			return cmdSpec{}, err
		}
		s, err := aptSpec(sub)
		if err != nil {
			return cmdSpec{}, err
		}
		return cmdSpec{name: s.Name, args: s.Args, env: s.Env}, nil
	case protocol.JobServiceState:
		// params.service is operator-supplied; reject anything that is not a
		// plain unit name before it becomes argv (no injection surface).
		raw, ok := job.Params["service"]
		if !ok {
			return cmdSpec{}, errors.New(`missing param "service"`)
		}
		service, ok := raw.(string)
		if !ok {
			return cmdSpec{}, errors.New(`param "service" must be a string`)
		}
		service = strings.TrimSpace(service)
		if !units.ValidName(service) {
			return cmdSpec{}, fmt.Errorf("invalid service name %q", service)
		}
		return cmdSpec{
			name: "systemctl",
			args: []string{"status", service, "--no-pager", "-l"},
		}, nil
	default:
		return cmdSpec{}, fmt.Errorf("unknown job type %q", job.Type)
	}
}

// aptSubForJob hard-maps apt maintenance job types onto the whitelisted
// helper subcommands. Deliberately a closed table: a job type that is not in
// it can never reach argv as an apt invocation.
func aptSubForJob(jobType string) (apt.Sub, error) {
	switch jobType {
	case protocol.JobAPTUpdate:
		return apt.Update, nil
	case protocol.JobAPTUpgrade:
		return apt.Upgrade, nil
	case protocol.JobAPTFixBroken:
		return apt.FixBroken, nil
	case protocol.JobCheckUpdates:
		return apt.Simulate, nil
	}
	return "", fmt.Errorf("job type %q is not an apt maintenance job", jobType)
}

// execResult is the raw outcome of running a command.
type execResult struct {
	exitCode int
	stdout   string
	stderr   string
	timedOut bool
	err      error // non-nil when the process exited non-zero / was killed
	startErr error // non-nil when the binary could not be started
}

// exec runs the command with a hard timeout. On timeout the whole process
// group is SIGKILLed.
func (r *Runner) exec(ctx context.Context, spec cmdSpec, timeout time.Duration) execResult {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(cctx, spec.name, spec.args...)
	if len(spec.env) > 0 {
		cmd.Env = append(os.Environ(), spec.env...)
	}
	setupProcGroup(cmd)
	// Replace the default single-process kill with a group kill; WaitDelay
	// guarantees Wait returns even if a grandchild still holds the pipe.
	cmd.Cancel = func() error { return killProcGroup(cmd.Process) }
	cmd.WaitDelay = waitDelay

	var stdout, stderr tailBuffer
	stdout.cap = r.tailCap()
	stderr.cap = r.tailCap()
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()

	res := execResult{
		stdout:   stdout.String(),
		stderr:   stderr.String(),
		exitCode: -1,
	}
	if errors.Is(cctx.Err(), context.DeadlineExceeded) {
		res.timedOut = true
		res.err = runErr
		return res
	}
	if runErr == nil {
		res.exitCode = 0
		return res
	}
	var exitErr *exec.ExitError
	if errors.As(runErr, &exitErr) {
		res.exitCode = exitErr.ExitCode()
		res.err = runErr
		return res
	}
	// Spawn failure (binary missing, permission denied, …).
	res.startErr = runErr
	res.err = runErr
	return res
}

func (r *Runner) tailCap() int {
	if r.TailBytes <= 0 {
		return TailCapBytes
	}
	return r.TailBytes
}

// tailBuffer keeps only the last cap bytes written to it. Safe for concurrent
// writes (exec copies pipes from reader goroutines) and concurrent reads.
type tailBuffer struct {
	mu  sync.Mutex
	cap int
	buf []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.cap <= 0 {
		return len(p), nil
	}
	if len(p) >= t.cap {
		t.buf = append(t.buf[:0], p[len(p)-t.cap:]...)
		return len(p), nil
	}
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.cap {
		// Copy the tail so the oversized backing array can be collected.
		trimmed := make([]byte, t.cap)
		copy(trimmed, t.buf[len(t.buf)-t.cap:])
		t.buf = trimmed
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}

func appendNote(base, note string) string {
	if strings.TrimSpace(base) == "" {
		return note + "\n"
	}
	return base + "\n" + note + "\n"
}

func strPtr(s string) *string { return &s }
func intPtr(i int) *int       { return &i }
