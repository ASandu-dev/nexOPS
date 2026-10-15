# NexOPS Production Deployment Guide

This document covers production deployment, upgrade procedures, backup, and security hardening for the NexOPS control plane.

---

## Prerequisites

- Docker Engine 24+ and Docker Compose v2+
- A domain name with DNS pointing to your server
- TLS certificates (Let's Encrypt recommended)
- Clerk account for authentication (production keys)
- PostgreSQL 16+ (provided by Docker Compose, or external)

---

## 1. Initial Setup

### 1.1 Clone and Configure

```bash
git clone <your-repo> nexops
cd nexops
cp .env.example .env
```

### 1.2 Edit `.env` with Production Values

```bash
# Required: Clerk production keys (from https://dashboard.clerk.com)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...

# Required: Public HTTPS URL agents will use to reach the control plane
NEXT_PUBLIC_APP_URL=https://nexops.example.com

# Database (use external PostgreSQL for production HA, or keep Docker Compose)
# Generate a strong password: openssl rand -base64 32
POSTGRES_PASSWORD=your_strong_random_password_here
DATABASE_URL=postgresql://nexops:${POSTGRES_PASSWORD}@postgres:5432/nexops?schema=public

# Optional overrides
TELEMETRY_RETENTION_DAYS=30
```

**Note:** PostgreSQL is bound to `127.0.0.1:5432` on the host. Do not expose port 5432 externally. Use a reverse proxy for TLS termination on port 443.

**Critical:** `NEXT_PUBLIC_APP_URL` must be the **exact HTTPS URL** agents will use. Agent install commands are generated from this value.

### 1.3 TLS Termination (Reverse Proxy)

The control plane runs on HTTP port 3000 inside Docker. You **must** terminate TLS at a reverse proxy.

#### Caddy (Recommended - Automatic HTTPS)

```caddy
# /etc/caddy/Caddyfile
nexops.example.com {
    reverse_proxy localhost:3000
}
```

```bash
# Run Caddy (systemd service or Docker)
docker run -d --name caddy --restart unless-stopped \
  -p 80:80 -p 443:443 -p 443:443/udp \
  -v /etc/caddy/Caddyfile:/etc/caddy/Caddyfile \
  -v caddy_data:/data -v caddy_config:/config \
  caddy:2-alpine
```

#### Nginx (Manual Certificates)

```nginx
# /etc/nginx/sites-available/nexops
server {
    listen 80;
    server_name nexops.example.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name nexops.example.com;

    ssl_certificate /etc/letsencrypt/live/nexops.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nexops.example.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## 2. Deploy

```bash
# Build and start all services
docker compose up -d --build

# Verify all services are healthy
docker compose ps
# Expected: postgres (healthy), migrate (exited 0), control-plane (healthy)

# Check control-plane logs
docker compose logs -f control-plane
```

### 2.1 Verify Health

```bash
# Health endpoint (no auth)
curl -f https://nexops.example.com/

# Should return 200 with the dashboard HTML (or Clerk sign-in page)
```

### 2.2 Enrol First Target

1. Sign in to the dashboard at `https://nexops.example.com`
2. Create a target: `POST /api/targets` (via UI or curl with Clerk session)
3. Copy the returned `installCommand`
4. Run it as root on the target VM:

```bash
curl -fsSLO "https://nexops.example.com/api/agent/releases/install.sh" \
  && curl -fsSLO "https://nexops.example.com/api/agent/releases/install.sh.sha256" \
  && sha256sum -c install.sh.sha256 \
  && sudo ENROL_TOKEN=<token> CONTROL_PLANE_URL=https://nexops.example.com OS=ubuntu bash install.sh \
  && rm -f install.sh install.sh.sha256
```

5. Target should appear as `ONLINE` within 90 seconds.

---

## 3. Upgrade Procedure

### 3.1 Standard Upgrade

```bash
cd /path/to/nexops
git pull origin main

# Rebuild and restart (migrate runs automatically via compose dependency)
docker compose up -d --build

# Verify
docker compose ps
docker compose logs -f control-plane
```

**What happens automatically:**
- `migrate` service runs `prisma db push` (idempotent schema sync)
- `control-plane` restarts with new image
- Agent binaries are rebuilt into the new image (served at `/api/agent/releases/*`)

### 3.2 Agent Upgrades

Agents **do not auto-upgrade**. After a control-plane upgrade:

1. Re-run the install command on each target (fetches new binary, verifies checksum, replaces `/usr/local/bin/nexops-agent`, restarts systemd unit).
2. Or use a job: `POST /api/jobs` with `type: "APT_UPGRADE"` (if you package the agent in a repo).

**Credential rotation:** Re-running install generates a new enrolment token → new agent identity → new bearer credential. The old credential is revoked when the target is deleted/recreated.

---

## 4. Backup

### 4.1 PostgreSQL Backup (pg_dump)

```bash
# Backup to timestamped file
docker compose exec -T postgres pg_dump -U nexops nexops > "nexops-backup-$(date +%F-%H%M).sql"

# Restore
docker compose exec -T postgres psql -U nexops nexops < backup-file.sql
```

### 4.2 Volume Backup (Full Disk)

```bash
# Stop services, backup volume, restart
docker compose down
docker run --rm -v nexops_pgdata:/data -v $(pwd):/backup alpine tar czf /backup/pgdata-$(date +%F).tar.gz -C /data .
docker compose up -d
```

### 4.3 Automated Daily Backup (systemd timer)

Create `/etc/systemd/system/nexops-backup.service`:

```ini
[Unit]
Description=NexOPS PostgreSQL Backup
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/nexops
ExecStart=/usr/bin/docker compose exec -T postgres pg_dump -U nexops nexops
StandardOutput=file:/var/log/nexops-backup.log
```

Create `/etc/systemd/system/nexops-backup.timer`:

```ini
[Unit]
Description=Daily NexOPS Backup

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl enable --now nexops-backup.timer
```

---

## 5. Telemetry Retention & Storage Estimation

| Parameter | Value |
|-----------|-------|
| Heartbeat interval | 30 seconds (configurable via settings) |
| Snapshots per target per day | 2,880 (at 30s) or 1,440 (at 60s) |
| Row size (approx) | ~2 KB (JSON raw + indexed columns) |
| Default retention | 30 days (`TELEMETRY_RETENTION_DAYS`) |

**Storage formula:**
```
Total rows = targets × snapshots_per_day × retention_days
Disk usage ≈ Total rows × 2 KB
```

**Examples:**
- 10 targets, 30s interval, 30 days → 864,000 rows → ~1.7 GB
- 100 targets, 60s interval, 30 days → 4,320,000 rows → ~8.6 GB
- 1000 targets, 60s interval, 30 days → 43,200,000 rows → ~86 GB

**Adjust retention** via `TELEMETRY_RETENTION_DAYS` or the Settings API (`PATCH /api/settings`).

---

## 6. Security Checklist

| Item | Requirement | Verification |
|------|-------------|--------------|
| **TLS** | Required for all production deployments. Agent bearer credentials transit in `Authorization: Bearer` headers. | `curl -I https://nexops.example.com` shows `Strict-Transport-Security` |
| **Clerk Keys** | Use production keys (`pk_live_`, `sk_live_`). Never commit to git. | Check `.env` not in repo; `grep -r "sk_live" .` returns nothing |
| **Database Password** | Strong random password. Not `nexops`. | `openssl rand -base64 32` |
| **Firewall** | Only expose 80/443 (reverse proxy) and 22 (SSH). Block 5432, 3000 externally. PostgreSQL binds to 127.0.0.1 only. | `nmap -p 3000,5432 <server-ip>` shows filtered/closed |
| **Docker** | Control plane runs as non-root `nextjs` user (UID 1001). | `docker compose exec control-plane whoami` → `nextjs` |
| **Backups** | Automated, tested, off-site. | Restore test quarterly |
| **Updates** | Regular `docker compose pull` + rebuild for base image security patches. | Monthly schedule |

---

## 7. Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| `control-plane` unhealthy | Clerk keys invalid/missing | Verify `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` in `.env` |
| `migrate` fails | Database not ready / schema conflict | Check `docker compose logs migrate`; ensure `postgres` is healthy first |
| Agent install fails (checksum) | Binary mismatch / corrupted download | Rebuild: `docker compose up -d --build`; re-run install |
| Agent shows `OFFLINE` | Network / firewall / wrong `CONTROL_PLANE_URL` | Verify target can `curl https://nexops.example.com/` |
| `401` on agent heartbeat | Credential revoked (target deleted) | Re-enrol target (new install command) |

---

## 8. Architecture Notes

- **Agent binaries are baked into the control-plane image** at `/app/agent-dist`. No separate volume needed.
- **Migrations run as a one-shot `migrate` service** before `control-plane` starts (`depends_on: service_completed_successfully`).
- **Healthcheck** hits `/` (root page) — no auth required. Returns 200 if Next.js process is responsive.
- **`tmpfs: /tmp`** mounted for Next.js runtime needs (read-only root fs otherwise).
- **PostgreSQL binds to `127.0.0.1:5432`** on the host — not exposed externally. Password via `POSTGRES_PASSWORD` env var.

---

## 9. Environment Variable Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POSTGRES_PASSWORD` | Yes | — | Strong random password for PostgreSQL (generate with `openssl rand -base64 32`) |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Yes | — | Clerk public key |
| `CLERK_SECRET_KEY` | Yes | — | Clerk secret key (server only) |
| `NEXT_PUBLIC_APP_URL` | Yes | — | Public HTTPS URL for agent install commands |
| `AGENT_DIST_DIR` | No | `/app/agent-dist` | Internal path to agent binaries |
| `TELEMETRY_RETENTION_DAYS` | No | `30` | Days to retain telemetry snapshots |
| `PORT` | No | `3000` | HTTP port (internal) |
| `NODE_ENV` | No | `production` | Node environment |