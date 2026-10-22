# NexOPS

NexOPS is a self-hosted control plane for managing Linux VMs and hosts — targets, telemetry, package maintenance jobs, and an audit trail — with a small outbound-only Go agent on each machine. The web dashboard is built with Next.js and PostgreSQL. Agents poll the control plane over HTTP(S) — HTTPS in production, plain HTTP in local dev — with no inbound ports opened on targets. Operator sign-in is handled by Clerk.

---

## Features

- **Targets with single-use enrolment tokens** — 15-minute TTL, only the SHA-256 hash is stored; the plaintext token is returned once in the `POST /api/targets` response.
- **Derived target status** — `ONLINE` / `DEGRADED` / `OFFLINE` computed from heartbeat freshness (≤90 s) and telemetry freshness (≤5 min); `PENDING_ENROLMENT`, `ENROLMENT_FAILED`, `MAINTENANCE` (display overlay when a job is `RUNNING`), `REMOVED` (soft-deleted).
- **Telemetry snapshots** — CPU (two-sample `/proc/stat` delta), load averages, memory (MemAvailable-based, not MemFree), swap, disk usage (physical filesystems only via `/proc/mounts` + `statfs`), per-interface network counters and rates, uptime/boot time, kernel, hostname, watched systemd unit states, and pending APT package updates (cached 10 min, `null` when not recently measured).
- **APT maintenance jobs** — dispatched on the next heartbeat with live cancellation and per-job stdout/stderr tails (last ~8 KB). Job types:
  - `APT_UPDATE` — `apt-get update -y`
  - `APT_UPGRADE` — `DEBIAN_FRONTEND=noninteractive apt-get upgrade -y`
  - `APT_FIX_BROKEN` — `DEBIAN_FRONTEND=noninteractive apt-get -f install -y`
  - `CHECK_UPDATES` — `apt-get -s upgrade` (dry-run count)
  - `SERVICE_STATUS` — `systemctl status <service> --no-pager -l`
  - `SELF_UPDATE` — downloads the release binary for the target architecture, verifies the `.sha256`, atomically swaps it in, reports the result, then re-execs the agent
- **Fleet-wide upgrade dispatch** — one request queues an APT upgrade or an agent self-update on every eligible target; ineligible targets (offline, pending enrolment, enrolment failed, maintenance) are skipped and reported back with their reason.
- **One-click job retry** — failed and timed-out jobs can be re-queued from the jobs list, the target job history, or the job dialog; the original job is kept as history and the retry is queued as a new job.
- **Audit log** — every mutation writes an `AuditEvent` (actor ID + type, action, target type + ID, metadata, timestamp); reads are not audited.
- **Dark / light theme** — preference stored in a cookie and mirrored to localStorage; the server renders the correct class on `<html>` so it is right on every page including sign-in; a blocking inline bootstrap in `<head>` applies the system preference on first visit with no flash.
- **Target detail with live polling** — telemetry charts and job history refresh at 15 s / 30 s intervals; status badge refreshes on the 15 s poll.

---

## How it works

1. **Enrol** via a one-time token (15-minute TTL, hash-only storage) using the served, SHA-256-verified `install.sh` (checksum verified before execution).
2. The agent generates an Ed25519 keypair (private key never leaves the target), authenticates with the token, and receives a **per-agent bearer credential** (only its SHA-256 hash is stored server-side; the enrolment token is scrubbed from disk).
3. The agent loop **beats immediately on start**, then every 30 seconds, posting telemetry and receiving pending jobs inline in the heartbeat response.
4. **Collection is bounded** (~10 s); if a collector wedges (e.g. a slow `apt-get -s upgrade`), the beat proceeds with partial data and missing metrics sent as `null` rather than delaying past the 90 s liveness window.
5. **Cancellation** is eventual: `POST /api/jobs/:id/cancel` marks the job `CANCELLED` immediately; the next heartbeat returns the ID in `cancelledJobIds`, the agent kills the process group, and reports a `CANCELLED` result (idempotent — the operator's write wins).

---

## Quick start (Docker)

**Prerequisites:** Docker + Compose, a Clerk application (publishable key + secret key), and at least one Linux host (amd64 or arm64) that can reach the control plane outbound.

1. `cp .env.example .env` and fill in:
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — Clerk public key (safe for browser)
   - `CLERK_SECRET_KEY` — Clerk secret key (server-only)
   - `POSTGRES_PASSWORD` — strong random value (e.g. `openssl rand -base64 32`)
   - `APP_PORT` — host port to publish (default `3000`)
   - `PUBLIC_ORIGIN` — pin the origin used in agent install commands (e.g. `http://192.168.1.50:3211` or `https://nexops.example.com`); leave empty to use the request origin
2. `docker compose up -d --build`
3. Open `http://localhost:<APP_PORT>` (default 3000).
4. Sign in with Clerk → **Targets → Add target** → copy the install command → run it on the target with `sudo` → the target shows up as `ONLINE` within seconds.

The install command follows the address you opened the dashboard on. Set `PUBLIC_ORIGIN` to pin it (required when enrolling machines over LAN or from production behind a reverse proxy).

---

## Configuration

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `POSTGRES_PASSWORD` | Yes | — | Strong random password for PostgreSQL |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Yes | — | Clerk public key (browser-safe) |
| `CLERK_SECRET_KEY` | Yes | — | Clerk secret key (server-only) |
| `APP_PORT` | No | `3000` | Host port published by docker compose (container listens on 3000) |
| `PUBLIC_ORIGIN` | No | — | Pin origin for agent install commands (e.g. `https://nexops.example.com`) |
| `NEXT_PUBLIC_APP_URL` | No | unset | Compose supplies it from `PUBLIC_ORIGIN` when that pin is set; otherwise the control plane uses the origin the request came from |
| `AGENT_DIST_DIR` | No | `/app/agent-dist` | Internal path to agent binaries and install.sh |
| `TELEMETRY_RETENTION_DAYS` | No | `30` | Days to retain `TelemetrySnapshot` rows |
| `PORT` | No | `3000` | Internal HTTP port (container) |
| `NODE_ENV` | No | `production` | Node environment |

---

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system overview, protocol contract, API surface, security model, retention, byte handling
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — production deployment, TLS/reverse proxy (Caddy/Nginx), backup (pg_dump + volume), upgrade procedures, security checklist
- [`docs/AGENT.md`](docs/AGENT.md) — agent internals, enrolment flow, job execution, systemd management, troubleshooting, upgrade
- [`agent/README.md`](agent/README.md) — agent development, build (Go 1.22+, stdlib only), protocol, security model, directory layout

---

## Development

```bash
# Control plane (Next.js)
pnpm install
pnpm dev          # falls back to the request origin when NEXT_PUBLIC_APP_URL is unset
pnpm build
pnpm lint
pnpm typecheck

# Agent (Go)
make test-agent   # runs Go unit tests in Docker (golang:1.22-alpine)
make agent        # builds linux/amd64 + linux/arm64 binaries into ./agent-dist with .sha256 sidecars
make build        # builds the full multi-stage Docker image
make up           # docker compose up -d --build
make down         # docker compose down
make logs         # docker compose logs -f
make db-push      # prisma db push via the migrate service
make fmt          # prettier + go fmt
make lint         # eslint + go vet
make typecheck    # tsc --noEmit
```

There is currently no TypeScript test suite.

---

## Status & limitations

- Single-node control plane (no HA, no leader election)
- Linux-only agents (Ubuntu 22.04+ / Debian 12+; amd64 and arm64)
- Targets must be able to reach the control plane outbound over HTTPS (port 443 in production)
- Agent binaries are baked into the control-plane image; agents built with self-update support upgrade themselves from the dashboard, while agents predating it need one final manual re-run of the install command (bootstrap). Release binaries are also attached to GitHub Releases.
- Early-stage project — expect breaking changes
- No built-in secrets management beyond Clerk; bring your own Vault/Sealed Secrets if needed
- Telemetry retention defaults to 30 days; adjust via `TELEMETRY_RETENTION_DAYS` or Settings API

---

## Licence

Free for non-commercial use, which includes personal and homelab use — see [LICENSE](LICENSE).