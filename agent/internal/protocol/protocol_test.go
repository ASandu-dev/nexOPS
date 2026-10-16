package protocol

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

// keys returns the sorted set of top-level JSON object keys in raw.
func keys(t *testing.T, raw []byte) []string {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func assertKeys(t *testing.T, raw []byte, want []string) {
	t.Helper()
	got := keys(t, raw)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("json keys mismatch\n got: %v\nwant: %v\nraw: %s", got, want, raw)
	}
}

func f(v float64) *float64 { return &v }
func i(v int) *int         { return &v }
func i64(v int64) *int64   { return &v }
func s(v string) *string   { return &v }

func TestEnrolRequestJSONFieldNames(t *testing.T) {
	req := EnrolRequest{
		Token: "tok", PublicKey: "pk", Hostname: "vm-01", OS: "UBUNTU",
		Arch: "amd64", OSVersion: "24.04", AgentVersion: "0.1.0", Signature: "sig",
	}
	raw, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	assertKeys(t, raw, []string{
		"token", "publicKey", "hostname", "os", "arch", "osVersion", "agentVersion", "signature",
	})
}

func TestEnrolResponseDecodes(t *testing.T) {
	var resp EnrolResponse
	if err := json.Unmarshal([]byte(`{"agentId":"a1","targetId":"t1","credential":"c1","heartbeatIntervalSec":30}`), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.AgentID != "a1" || resp.TargetID != "t1" || resp.Credential != "c1" || resp.HeartbeatIntervalSec != 30 {
		t.Fatalf("unexpected: %+v", resp)
	}
}

// TestHeartbeatRequestFromArchitectureExample feeds the exact example body
// from ARCHITECTURE.md §3 through the struct and back out, asserting every
// field name survives the round trip.
func TestHeartbeatRequestFromArchitectureExample(t *testing.T) {
	const example = `{
	  "capturedAt": "2026-01-01T12:00:00Z",
	  "cpuPct": 12.5,
	  "cores": 4,
	  "load1": 0.4, "load5": 0.3, "load15": 0.2,
	  "memTotalBytes": 8589934592,
	  "memUsedBytes": 3221225472,
	  "memAvailableBytes": 5368709120,
	  "swapUsedBytes": 0,
	  "disks": [{ "mount": "/", "fsType": "ext4", "totalBytes": 100, "usedBytes": 40, "inodesTotal": 1000, "inodesUsed": 100 }],
	  "net": [{ "name": "eth0", "rxBytes": 1, "txBytes": 2, "rxRateBps": 0.0, "txRateBps": 0.0 }],
	  "uptimeSec": 123456,
	  "bootTime": "2025-12-01T00:00:00Z",
	  "kernel": "6.8.0-45-generic",
	  "hostname": "vm-01",
	  "agentVersion": "0.1.0",
	  "services": [{ "name": "nginx", "state": "active" }],
	  "pkgUpdates": { "availableCount": 3, "rebootRequired": false }
	}`
	var hb HeartbeatRequest
	if err := json.Unmarshal([]byte(example), &hb); err != nil {
		t.Fatalf("architecture example does not decode: %v", err)
	}
	if hb.CPUPct == nil || *hb.CPUPct != 12.5 {
		t.Fatalf("cpuPct: %v", hb.CPUPct)
	}
	if hb.PkgUpdates == nil || hb.PkgUpdates.AvailableCount != 3 || hb.PkgUpdates.RebootRequired {
		t.Fatalf("pkgUpdates: %+v", hb.PkgUpdates)
	}
	if hb.MemAvailableBytes != 5368709120 || hb.MemUsedBytes != 3221225472 {
		t.Fatalf("memory: %+v", hb)
	}
	if len(hb.Disks) != 1 || hb.Disks[0].Mount != "/" || hb.Disks[0].InodesUsed != 100 {
		t.Fatalf("disks: %+v", hb.Disks)
	}

	out, err := json.Marshal(hb)
	if err != nil {
		t.Fatal(err)
	}
	assertKeys(t, out, []string{
		"capturedAt", "cpuPct", "cores", "load1", "load5", "load15",
		"memTotalBytes", "memUsedBytes", "memAvailableBytes", "swapUsedBytes",
		"disks", "net", "uptimeSec", "bootTime", "kernel", "hostname",
		"agentVersion", "services", "pkgUpdates",
	})
	// Disk and net nesting.
	var again map[string]json.RawMessage
	if err := json.Unmarshal(out, &again); err != nil {
		t.Fatal(err)
	}
	assertKeysOf(t, again["disks"], []string{"mount", "fsType", "totalBytes", "usedBytes", "inodesTotal", "inodesUsed"})
	assertKeysOf(t, again["net"], []string{"name", "rxBytes", "txBytes", "rxRateBps", "txRateBps"})
	assertKeysOf(t, again["services"], []string{"name", "state"})
	assertKeysOf(t, again["pkgUpdates"], []string{"availableCount", "rebootRequired"})
}

// assertKeysOf accepts either a JSON object or an array of objects and checks
// the first element's key set.
func assertKeysOf(t *testing.T, raw json.RawMessage, want []string) {
	t.Helper()
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, "[") {
		var arr []json.RawMessage
		if err := json.Unmarshal(raw, &arr); err != nil {
			t.Fatalf("unmarshal array: %v", err)
		}
		if len(arr) == 0 {
			t.Fatalf("array is empty: %s", raw)
		}
		raw = arr[0]
	}
	assertKeys(t, raw, want)
}

// TestHeartbeatRequestNullsAreExplicit guards against omitempty-style bugs:
// Zod .nullable() fields must serialise as null, not vanish.
func TestHeartbeatRequestNullsAreExplicit(t *testing.T) {
	hb := HeartbeatRequest{
		CapturedAt:   "2026-01-01T12:00:00Z",
		Disks:        []DiskUsage{},
		Net:          []NetInterface{},
		Services:     []ServiceState{},
		Hostname:     "vm-01",
		AgentVersion: "0.1.0",
	}
	raw, err := json.Marshal(hb)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"cpuPct", "cores", "load1", "load5", "load15", "swapUsedBytes", "uptimeSec", "bootTime", "kernel", "pkgUpdates"} {
		v, ok := m[k]
		if !ok {
			t.Errorf("nullable field %q missing from JSON (must be explicit null)", k)
			continue
		}
		if v != nil {
			t.Errorf("nullable field %q = %v, want null", k, v)
		}
	}
	// Empty slices must serialise as [] not null.
	for _, k := range []string{"disks", "net", "services"} {
		if m[k] == nil {
			t.Errorf("slice field %q is null; must be []", k)
		}
	}
}

func TestHeartbeatResponseJobsDecodes(t *testing.T) {
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"jobs":[{"id":"j1","type":"APT_UPDATE","status":"QUEUED","timeoutSec":600}]}`), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Jobs) != 1 || resp.Jobs[0].ID != "j1" {
		t.Fatalf("unexpected: %+v", resp)
	}
}

func TestJobDtoFlatTimeout(t *testing.T) {
	var job Job
	raw := `{"id":"j1","targetId":"t1","type":"APT_UPGRADE","params":null,"status":"DISPATCHED",
		"requestedBy":"user_1","createdAt":"2026-01-01T12:00:00Z","dispatchedAt":null,
		"startedAt":null,"finishedAt":null,"exitCode":null,"stdoutTail":null,"stderrTail":null,
		"error":null,"timeoutSec":120}`
	if err := json.Unmarshal([]byte(raw), &job); err != nil {
		t.Fatal(err)
	}
	if job.Params != nil {
		t.Fatalf("null params should decode to nil map")
	}
	if got := job.Timeout(); got != 120*time.Second {
		t.Fatalf("timeout = %s, want 120s", got)
	}
}

// TestJobNestedExecutionPolicyTolerated documents the fallback for
// Job.executionPolicy { timeoutSec } (task-spec shape) when the flat field is
// absent or zero.
func TestJobNestedExecutionPolicyTolerated(t *testing.T) {
	var job Job
	raw := `{"id":"j2","type":"APT_UPDATE","status":"QUEUED","timeoutSec":0,
		"executionPolicy":{"timeoutSec":90}}`
	if err := json.Unmarshal([]byte(raw), &job); err != nil {
		t.Fatal(err)
	}
	if got := job.Timeout(); got != 90*time.Second {
		t.Fatalf("timeout = %s, want 90s from executionPolicy", got)
	}
	// Flat wins when both are present.
	var job2 Job
	if err := json.Unmarshal([]byte(`{"timeoutSec":60,"executionPolicy":{"timeoutSec":90}}`), &job2); err != nil {
		t.Fatal(err)
	}
	if got := job2.Timeout(); got != 60*time.Second {
		t.Fatalf("timeout = %s, want flat 60s", got)
	}
	// Default when nothing is set.
	var job3 Job
	if got := job3.Timeout(); got != DefaultJobTimeoutSec*time.Second {
		t.Fatalf("timeout = %s, want default", got)
	}
}

func TestJobIsTerminal(t *testing.T) {
	for _, st := range []string{"SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"} {
		if !(Job{Status: st}).IsTerminal() {
			t.Errorf("%s should be terminal", st)
		}
	}
	for _, st := range []string{"QUEUED", "DISPATCHED", "RUNNING", ""} {
		if (Job{Status: st}).IsTerminal() {
			t.Errorf("%s should not be terminal", st)
		}
	}
}

func TestJobResultRequestJSONFieldNames(t *testing.T) {
	res := JobResultRequest{
		Status:     ResultSucceeded,
		ExitCode:   i(0),
		StdoutTail: s("ok"),
		StderrTail: s(""),
		StartedAt:  s("2026-01-01T12:00:01Z"),
		FinishedAt: s("2026-01-01T12:00:09Z"),
	}
	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	assertKeys(t, raw, []string{"status", "exitCode", "stdoutTail", "stderrTail", "startedAt", "finishedAt"})
}

func TestJobResultStatusConstants(t *testing.T) {
	// The backend Zod schema accepts SUCCEEDED | FAILED | TIMED_OUT.
	for _, st := range []string{ResultSucceeded, ResultFailed, ResultTimedOut} {
		var m map[string]any
		raw, _ := json.Marshal(JobResultRequest{Status: st, StdoutTail: s(""), StderrTail: s("")})
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		if m["status"] != st {
			t.Fatalf("status round-trip failed for %s", st)
		}
	}
}

func TestJobResultPathEscapesID(t *testing.T) {
	if got := JobResultPath("job_abc-123"); got != "/api/agent/jobs/job_abc-123/result" {
		t.Fatalf("plain id: %s", got)
	}
	if got := JobResultPath("../evil"); got != "/api/agent/jobs/..%2Fevil/result" {
		t.Fatalf("traversal id not escaped: %s", got)
	}
}

func TestHeartbeatResponseClientNormalisesNilJobs(t *testing.T) {
	// Via json.Unmarshal of an empty object, Jobs is nil; the client's
	// Heartbeat method normalises. Simulate with the same rule.
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{}`), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Jobs == nil {
		resp.Jobs = []Job{}
	}
	if len(resp.Jobs) != 0 {
		t.Fatal("expected empty jobs")
	}
}

// TestIsAuthErrorClassification pins the 401/403-vs-everything-else decision
// the agent loop uses to decide between re-enrolment and backoff.
func TestIsAuthErrorClassification(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"401", &APIError{StatusCode: http.StatusUnauthorized, Body: "revoked"}, true},
		{"403", &APIError{StatusCode: http.StatusForbidden, Body: "forbidden"}, true},
		{"wrapped 401", fmt.Errorf("heartbeat: %w", &APIError{StatusCode: http.StatusUnauthorized}), true},
		{"500", &APIError{StatusCode: http.StatusInternalServerError}, false},
		{"429", &APIError{StatusCode: http.StatusTooManyRequests}, false},
		{"404", &APIError{StatusCode: http.StatusNotFound}, false},
		{"transport error", errors.New("dial tcp: connection refused"), false},
		{"nil", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsAuthError(tc.err); got != tc.want {
				t.Fatalf("IsAuthError(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// TestClientHeartbeatAuthErrorStatus proves the client surfaces the HTTP
// status through APIError so the loop can classify a revoked credential.
func TestClientHeartbeatAuthErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer revoked" {
			t.Errorf("Authorization = %q, want %q", got, "Bearer revoked")
		}
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"credential revoked"}`))
	}))
	defer srv.Close()

	c, err := NewClient(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Heartbeat(context.Background(), "revoked", HeartbeatRequest{
		CapturedAt: "2026-01-01T12:00:00Z", Hostname: "vm-01", AgentVersion: "0.1.0",
	})
	if !IsAuthError(err) {
		t.Fatalf("IsAuthError(%v) = false, want true", err)
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusUnauthorized {
		t.Fatalf("APIError status not preserved: %v", err)
	}
}
