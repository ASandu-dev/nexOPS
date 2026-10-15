package jobs

import (
	"context"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/nexops/agent/internal/protocol"
)

func TestValidateServiceName(t *testing.T) {
	valid := []string{"nginx", "ssh", "sshd", "cron", "systemd-journald", "getty@tty1", "app.timer", "foo_bar", "a.b-c_d@e"}
	for _, name := range valid {
		if !validServiceName(name) {
			t.Errorf("%q should be valid", name)
		}
	}
	invalid := []string{
		"",
		"nginx; rm -rf /",
		"$(whoami)",
		"`id`",
		"foo bar",
		"foo|bar",
		"foo/bar",
		"../evil",
		"-p",
		"--no-pager",
		"nginx\nrm -rf /",
		"nginx&sleep 1",
		"a>b",
		strings.Repeat("x", 257),
	}
	for _, name := range invalid {
		if validServiceName(name) {
			t.Errorf("%q must be rejected", name)
		}
	}
}

// validServiceName is the Runner's own validation path: a SERVICE_STATUS job
// with this param must build a spec without error.
func validServiceName(name string) bool {
	_, err := buildSpec(protocol.Job{Type: protocol.JobServiceState, Params: map[string]any{"service": name}})
	return err == nil
}

func TestBuildSpecServiceStatusRejectsInjection(t *testing.T) {
	if _, err := buildSpec(protocol.Job{
		Type:   protocol.JobServiceState,
		Params: map[string]any{"service": "nginx; id"},
	}); err == nil {
		t.Fatal("injection payload must be rejected before exec")
	}
	if _, err := buildSpec(protocol.Job{
		Type:   protocol.JobServiceState,
		Params: map[string]any{"service": 42},
	}); err == nil {
		t.Fatal("non-string service must be rejected")
	}
	if _, err := buildSpec(protocol.Job{Type: protocol.JobServiceState}); err == nil {
		t.Fatal("missing service must be rejected")
	}
}

func TestBuildSpecKnownTypes(t *testing.T) {
	cases := []struct {
		jobType string
		name    string
		args    []string
	}{
		{protocol.JobAPTUpdate, "apt-get", []string{"update", "-y"}},
		{protocol.JobAPTUpgrade, "apt-get", []string{"upgrade", "-y"}},
		{protocol.JobCheckUpdates, "apt-get", []string{"-s", "upgrade"}},
	}
	for _, c := range cases {
		spec, err := buildSpec(protocol.Job{Type: c.jobType})
		if err != nil {
			t.Fatalf("%s: %v", c.jobType, err)
		}
		if spec.name != c.name || strings.Join(spec.args, " ") != strings.Join(c.args, " ") {
			t.Errorf("%s → %s %v", c.jobType, spec.name, spec.args)
		}
	}
	if _, err := buildSpec(protocol.Job{Type: "RM_RF"}); err == nil {
		t.Fatal("unknown job type must error")
	}
}

func TestRunInvalidServiceReportsFailedWithoutExec(t *testing.T) {
	r := NewRunner()
	res := r.Run(context.Background(), protocol.Job{
		Type:   protocol.JobServiceState,
		Params: map[string]any{"service": "nginx; id"},
	})
	if res.Status != protocol.ResultFailed {
		t.Fatalf("status = %s, want FAILED", res.Status)
	}
	if res.ExitCode != nil {
		t.Fatalf("exitCode = %v, want null (nothing executed)", *res.ExitCode)
	}
	if res.StderrTail == nil || !strings.Contains(*res.StderrTail, "invalid service name") {
		t.Fatalf("stderr = %v", res.StderrTail)
	}
	if res.StartedAt == nil || res.FinishedAt == nil {
		t.Fatal("timestamps must be set")
	}
}

func TestRunUnknownTypeReportsFailed(t *testing.T) {
	res := NewRunner().Run(context.Background(), protocol.Job{Type: "NOPE"})
	if res.Status != protocol.ResultFailed {
		t.Fatalf("status = %s", res.Status)
	}
	if res.StderrTail == nil || !strings.Contains(*res.StderrTail, "unknown job type") {
		t.Fatalf("stderr = %v", res.StderrTail)
	}
}

// TestRunnerTimeoutKillsCommand uses a real child process (`sleep`) with a
// tiny timeout and asserts the runner kills it promptly and reports TIMED_OUT.
func TestRunnerTimeoutKillsCommand(t *testing.T) {
	r := NewRunner()
	start := time.Now()
	res := r.exec(context.Background(), cmdSpec{name: "sleep", args: []string{"30"}}, 200*time.Millisecond)
	elapsed := time.Since(start)

	if !res.timedOut {
		t.Fatalf("expected timedOut, got %+v", res)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("kill took %s; process group not killed", elapsed)
	}
	if res.err == nil {
		t.Fatal("expected a non-nil error after kill")
	}
}

// TestResultFromMapsTimeoutToTimedOut pins the wire mapping (backend accepts
// SUCCEEDED | FAILED | TIMED_OUT).
func TestResultFromMapsTimeoutToTimedOut(t *testing.T) {
	started := time.Now()
	res := resultFrom(execResult{timedOut: true, err: context.DeadlineExceeded, exitCode: -1}, 200*time.Millisecond, started)
	if res.Status != protocol.ResultTimedOut {
		t.Fatalf("status = %s, want TIMED_OUT", res.Status)
	}
	if res.StderrTail == nil || !strings.Contains(*res.StderrTail, "timed out") {
		t.Fatalf("stderr = %v", res.StderrTail)
	}

	ok := resultFrom(execResult{exitCode: 0}, time.Second, started)
	if ok.Status != protocol.ResultSucceeded {
		t.Fatalf("status = %s, want SUCCEEDED", ok.Status)
	}

	failed := resultFrom(execResult{exitCode: 2, err: context.Canceled, startErr: nil}, time.Second, started)
	if failed.Status != protocol.ResultFailed {
		t.Fatalf("status = %s, want FAILED", failed.Status)
	}
	if failed.ExitCode == nil || *failed.ExitCode != 2 {
		t.Fatalf("exitCode = %v", failed.ExitCode)
	}
}

func TestRunnerCapturesOutput(t *testing.T) {
	if !hasSh() {
		t.Skip("sh not available")
	}
	r := NewRunner()
	res := r.exec(context.Background(), cmdSpec{name: "sh", args: []string{"-c", "echo out; echo err >&2; exit 3"}}, 5*time.Second)
	if res.exitCode != 3 {
		t.Fatalf("exitCode = %d, want 3", res.exitCode)
	}
	if strings.TrimSpace(res.stdout) != "out" || strings.TrimSpace(res.stderr) != "err" {
		t.Fatalf("stdout=%q stderr=%q", res.stdout, res.stderr)
	}
}

// TestTailBufferKeepsLastBytes verifies the 64KB tail discipline.
func TestTailBufferKeepsLastBytes(t *testing.T) {
	var buf tailBuffer
	buf.cap = 16
	if _, err := buf.Write([]byte("0123456789")); err != nil {
		t.Fatal(err)
	}
	if _, err := buf.Write([]byte("ABCDEFGHIJ")); err != nil {
		t.Fatal(err)
	}
	if got := buf.String(); got != "456789ABCDEFGHIJ" {
		t.Fatalf("tail = %q, want last 16 bytes", got)
	}
	// A single write larger than the cap keeps only its tail.
	var buf2 tailBuffer
	buf2.cap = 4
	if _, err := buf2.Write([]byte("abcdefgh")); err != nil {
		t.Fatal(err)
	}
	if got := buf2.String(); got != "efgh" {
		t.Fatalf("tail = %q", got)
	}
}

func hasSh() bool {
	_, err := exec.LookPath("sh")
	return err == nil
}
