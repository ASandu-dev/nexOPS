# NexOPS Agent

Outbound-only VM fleet agent for [NexOPS](../ARCHITECTURE.md). It enrols once
against the control plane, then polls `/api/agent/heartbeat` for telemetry
submission and job dispatch. It **never listens on a port**, so targets behind
NAT need no inbound access.

Single static Go binary, standard library only, `linux/amd64` + `linux/arm64`.

## Build

```sh
# Cross-compile into ../agent-dist/ with .sha256 sidecars (Go 1.22+)
make build

# Or via Docker; produces the same artifacts in ./out-dist
docker build -f build/Dockerfile --target dist --output type=local,dest=./out-dist .
```

`make vet` and `make test` run `go vet` / `go test` over the module. No external
dependencies, so no module proxy is required to build.

## Install

Normally install.sh from the control plane does this. Manually:

1. Copy `nexops-agent-linux-<arch>` to `/usr/local/bin/nexops-agent` (0755).
2. Create `/etc/nexops/agent.env` (0600):

   ```
   CONTROL_PLANE_URL=https://nexops.example.com
   ENROL_TOKEN=<one-time token from the UI>
   OS=ubuntu
   ```

3. Run as `nexops-agent` (systemd unit provided by install.sh).

### Configuration keys (`/etc/nexops/agent.env`)

| Key | Default | Notes |
| --- | --- | --- |
| `CONTROL_PLANE_URL` | — | required; `https://` (plain `http://` only for local dev) |
| `ENROL_TOKEN` | — | required until first enrolment; scrubbed from the file afterwards |
| `OS` | from `/etc/os-release` | `ubuntu` \| `debian` (case-insensitive) |
| `AGENT_STATE_DIR` | `/var/lib/nexops` | holds `state.json` + `key.pem` |
| `HEARTBEAT_INTERVAL_SEC` | value from enrol response (30) | override, 5–3600 |
| `WATCHED_SERVICES` | `ssh,sshd,cron,systemd-journald` | comma-separated unit names |

Commands: `nexops-agent run` (default), `nexops-agent version`.

## Protocol

Everything is JSON, camelCase, matching `src/lib/types.ts`. See
`internal/protocol/protocol.go` for the exact structs.

- `POST /api/agent/enrol` — `EnrolRequest { token, publicKey, hostname, os,
  arch, osVersion, agentVersion, signature }` → `EnrolResponse { agentId,
  targetId, credential, heartbeatIntervalSec }`. `signature` is a base64
  Ed25519 signature over the **raw token bytes**; `publicKey` is base64 std.
- `POST /api/agent/heartbeat` (Bearer credential) — `HeartbeatRequest`
  (telemetry) → `HeartbeatResponse { jobs: JobDto[] }`. Jobs are run inline.
- `POST /api/agent/jobs/:id/result` (Bearer credential) — `JobResultRequest
  { status, exitCode, stdoutTail, stderrTail, startedAt, finishedAt }`.
  `status` ∈ `SUCCEEDED | FAILED | TIMED_OUT`.

Job types: `APT_UPDATE` (`apt-get update -y`), `APT_UPGRADE`
(`DEBIAN_FRONTEND=noninteractive apt-get upgrade -y`), `APT_FIX_BROKEN`
(`DEBIAN_FRONTEND=noninteractive apt-get -f install -y`), `CHECK_UPDATES`
(`apt-get -s upgrade`), `SERVICE_STATUS` (`systemctl status <service>
--no-pager -l`). Jobs run **sequentially**; a poisoned service name is
rejected before it reaches argv.

Telemetry: CPU (two-sample `/proc/stat` delta), cores, loadavg, memory
(`MemAvailable` based), disks (`/proc/mounts` + `statfs`, physical filesystems
only), per-interface network counters + rates, uptime/boot time, kernel,
hostname, watched systemd unit states, and apt update summary (cached 10min).

## Security model

- Credential and private key live on the target only (mode 0600); the control
  plane stores only the SHA-256 of the credential.
- The single-use enrol token is removed from `agent.env` after successful
  enrolment. Enrolment is idempotent: a stored credential short-circuits it.
- TLS certificate verification is **never** disabled. No `-insecure` flag
  exists.
- No shell is ever invoked. Every command is an explicit argv vector;
  `SERVICE_STATUS` validates its service name against `[a-zA-Z0-9@._-]+` (with
  no leading `-`) and rejects anything else.
- Command output is capped at the last 64 KiB for the result report.
- Jobs are killed by process group on timeout (`executionPolicy.timeoutSec`,
  default 600s).

## Layout

```
cmd/nexops-agent      CLI entrypoint
internal/agent        heartbeat loop, backoff, graceful shutdown
internal/config       agent.env parsing, state.json, Ed25519 key persistence
internal/enrol        one-time enrolment
internal/jobs         job execution + output tailing
internal/metrics      /proc parsing (portable) + linux collection
internal/protocol     wire DTOs + HTTP client
internal/units        systemd unit-name validation
```
