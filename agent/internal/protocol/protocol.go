// Package protocol defines the agent↔control-plane wire format. Field names
// and shapes mirror src/lib/types.ts exactly (camelCase JSON). The agent is
// outbound-only: every request is a POST with the per-agent bearer credential,
// except enrolment which authenticates via the single-use enrol token.
package protocol

import (
	"net/url"
	"time"
)

// Job types (JOB_TYPES in types.ts).
const (
	JobAPTUpdate    = "APT_UPDATE"
	JobAPTUpgrade   = "APT_UPGRADE"
	JobAPTFixBroken = "APT_FIX_BROKEN"
	JobCheckUpdates = "CHECK_UPDATES"
	JobServiceState = "SERVICE_STATUS"
)

// Job result statuses. The backend accepts all four; TIMED_OUT/CANCELLED are
// reported after the agent kills the process group on timeout/cancel.
const (
	ResultSucceeded = "SUCCEEDED"
	ResultFailed    = "FAILED"
	ResultTimedOut  = "TIMED_OUT"
	ResultCancelled = "CANCELLED"
)

// DefaultJobTimeoutSec is applied when a job carries timeoutSec <= 0.
const DefaultJobTimeoutSec = 600

// API paths.
const (
	PathEnrol    = "/api/agent/enrol"
	PathHearbeat = "/api/agent/heartbeat"
)

// JobResultPath builds the result-report path for a job id. The id is
// path-escaped so a hostile id cannot traverse into another route.
func JobResultPath(id string) string {
	return "/api/agent/jobs/" + url.PathEscape(id) + "/result"
}

// EnrolRequest is POSTed once on first start. The signature is a base64
// Ed25519 signature over the raw (unencoded) enrol token bytes, proving the
// holder of the private key also received the token.
type EnrolRequest struct {
	Token        string `json:"token"`
	PublicKey    string `json:"publicKey"`
	Hostname     string `json:"hostname"`
	OS           string `json:"os"`
	Arch         string `json:"arch"`
	OSVersion    string `json:"osVersion"`
	AgentVersion string `json:"agentVersion"`
	Signature    string `json:"signature"`
}

// EnrolResponse is returned once; the credential is never re-issued by any
// read endpoint.
type EnrolResponse struct {
	AgentID              string `json:"agentId"`
	TargetID             string `json:"targetId"`
	Credential           string `json:"credential"`
	HeartbeatIntervalSec int    `json:"heartbeatIntervalSec"`
}

// DiskUsage mirrors DiskUsageDto. Byte/inode counters are exact on 64-bit
// systems; the backend converts to Prisma BigInt at the boundary.
type DiskUsage struct {
	Mount       string `json:"mount"`
	FSType      string `json:"fsType"`
	TotalBytes  int64  `json:"totalBytes"`
	UsedBytes   int64  `json:"usedBytes"`
	InodesTotal int64  `json:"inodesTotal"`
	InodesUsed  int64  `json:"inodesUsed"`
}

// NetInterface mirrors NetInterfaceDto. Rate fields are 0.0 on the first
// sample (no previous counter) or after a counter reset. IPs are address
// strings without CIDR prefixes; Operstate is the kernel's
// /sys/class/net/<iface>/operstate value, normalised to up/down/unknown.
type NetInterface struct {
	Name      string   `json:"name"`
	RxBytes   int64    `json:"rxBytes"`
	TxBytes   int64    `json:"txBytes"`
	RxRateBps float64  `json:"rxRateBps"`
	TxRateBps float64  `json:"txRateBps"`
	IPs       []string `json:"ips"`
	Operstate string   `json:"operstate"`
}

// DiskIOStat mirrors DiskIOStatDto. ReadBytes/WriteBytes are cumulative
// /proc/diskstats sector counters × 512. Rates are null on the first sample
// (no previous counter); a counter reset yields 0, never a negative spike.
type DiskIOStat struct {
	Device       string   `json:"device"`
	ReadBytes    int64    `json:"readBytes"`
	WriteBytes   int64    `json:"writeBytes"`
	ReadRateBps  *float64 `json:"readRateBps"`
	WriteRateBps *float64 `json:"writeRateBps"`
}

// ServiceState mirrors ServiceStateDto; state is a systemd ActiveState value
// (active/inactive/failed/…) or "unknown"/"not-found".
type ServiceState struct {
	Name  string `json:"name"`
	State string `json:"state"`
}

// PkgUpdateSummary mirrors PkgUpdateSummaryDto. Null on the wire when not
// measured (no apt, or the simulation failed).
type PkgUpdateSummary struct {
	AvailableCount int  `json:"availableCount"`
	RebootRequired bool `json:"rebootRequired"`
}

// HeartbeatRequest mirrors HeartbeatRequest. Nullable DTO fields are pointers
// so they serialise as explicit nulls (Zod .nullable() requires the key to be
// present). Slice fields must always be non-nil — a nil slice would marshal
// as null and fail backend validation.
type HeartbeatRequest struct {
	CapturedAt        string            `json:"capturedAt"`
	CPUModel          string            `json:"cpuModel"`
	CPUPct            *float64          `json:"cpuPct"`
	Cores             *int              `json:"cores"`
	Load1             *float64          `json:"load1"`
	Load5             *float64          `json:"load5"`
	Load15            *float64          `json:"load15"`
	MemTotalBytes     int64             `json:"memTotalBytes"`
	MemUsedBytes      int64             `json:"memUsedBytes"`
	MemAvailableBytes int64             `json:"memAvailableBytes"`
	SwapTotalBytes    *int64            `json:"swapTotalBytes"`
	SwapUsedBytes     *int64            `json:"swapUsedBytes"`
	OSPrettyName      string            `json:"osPrettyName"`
	Disks             []DiskUsage       `json:"disks"`
	DiskIO            []DiskIOStat      `json:"diskIO"`
	Net               []NetInterface    `json:"net"`
	UptimeSec         *int64            `json:"uptimeSec"`
	BootTime          *string           `json:"bootTime"`
	Kernel            *string           `json:"kernel"`
	Hostname          string            `json:"hostname"`
	AgentVersion      string            `json:"agentVersion"`
	Services          []ServiceState    `json:"services"`
	PkgUpdates        *PkgUpdateSummary `json:"pkgUpdates"`
	CollectionErrors  []string          `json:"collectionErrors,omitempty"`
	ActiveJobIds      []string          `json:"activeJobIds,omitempty"`
}

// HeartbeatResponse carries the jobs dispatched to this agent inline with the
// poll response (the agent never listens on a port).
type HeartbeatResponse struct {
	Jobs            []Job    `json:"jobs"`
	CancelledJobIds []string `json:"cancelledJobIds,omitempty"`
}

// ExecutionPolicy is tolerated as an alternative shape for the job timeout.
// The canonical backend DTO (JobDto in types.ts) carries timeoutSec flat on
// the job; older/parallel definitions wrapped it here.
type ExecutionPolicy struct {
	TimeoutSec int `json:"timeoutSec"`
}

// Job mirrors JobDto. Unknown JSON fields are ignored so the backend can add
// fields without breaking deployed agents.
type Job struct {
	ID              string           `json:"id"`
	TargetID        string           `json:"targetId"`
	Type            string           `json:"type"`
	Params          map[string]any   `json:"params"`
	Status          string           `json:"status"`
	RequestedBy     string           `json:"requestedBy"`
	CreatedAt       string           `json:"createdAt"`
	DispatchedAt    *string          `json:"dispatchedAt"`
	StartedAt       *string          `json:"startedAt"`
	FinishedAt      *string          `json:"finishedAt"`
	ExitCode        *int             `json:"exitCode"`
	StdoutTail      *string          `json:"stdoutTail"`
	StderrTail      *string          `json:"stderrTail"`
	Error           *string          `json:"error"`
	TimeoutSec      int              `json:"timeoutSec"`
	ExecutionPolicy *ExecutionPolicy `json:"executionPolicy"`
}

// IsTerminal reports whether the job already reached a terminal state (e.g.
// cancelled between dispatch and receipt) and must not be executed.
func (j Job) IsTerminal() bool {
	switch j.Status {
	case "SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT":
		return true
	}
	return false
}

// Timeout resolves the execution timeout: flat timeoutSec wins, then
// executionPolicy.timeoutSec, then DefaultJobTimeoutSec.
func (j Job) Timeout() time.Duration {
	sec := j.TimeoutSec
	if sec <= 0 && j.ExecutionPolicy != nil {
		sec = j.ExecutionPolicy.TimeoutSec
	}
	if sec <= 0 {
		sec = DefaultJobTimeoutSec
	}
	return time.Duration(sec) * time.Second
}

// JobResultRequest is POSTed to /api/agent/jobs/:id/result. Idempotent on the
// server: replaying a result for a terminal job is a no-op.
type JobResultRequest struct {
	Status     string  `json:"status"`
	ExitCode   *int    `json:"exitCode"`
	StdoutTail *string `json:"stdoutTail"`
	StderrTail *string `json:"stderrTail"`
	StartedAt  *string `json:"startedAt"`
	FinishedAt *string `json:"finishedAt"`
}
