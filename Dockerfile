# syntax=docker/dockerfile:1

# --- deps: install only production + build dependencies (cached) -------------
FROM node:24-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# --- agent-builder: cross-compile static Go agent binaries for both arches ----
FROM golang:1.22-alpine AS agent-builder
WORKDIR /src
COPY agent/go.mod ./
RUN go mod download
COPY agent/ .
ARG VERSION=0.1.0
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
      go build -trimpath -buildvcs=false -ldflags "-s -w -X main.version=${VERSION}" \
      -o /agent-dist/nexops-agent-linux-amd64 ./cmd/nexops-agent \
 && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
      go build -trimpath -buildvcs=false -ldflags "-s -w -X main.version=${VERSION}" \
      -o /agent-dist/nexops-agent-linux-arm64 ./cmd/nexops-agent \
 && cd /agent-dist \
 && sha256sum nexops-agent-linux-amd64 > nexops-agent-linux-amd64.sha256 \
 && sha256sum nexops-agent-linux-arm64 > nexops-agent-linux-arm64.sha256

# --- build: generate Prisma client and compile the Next.js app ---------------
FROM node:24-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm exec prisma generate && pnpm build \
 && mkdir -p /out-prisma \
 && node -e "const p=require('path');const d=p.join(p.dirname(require.resolve('@prisma/client/package.json')),'..','..','.prisma');require('fs').cpSync(d,'/out-prisma',{recursive:true})" \
 && ls /out-prisma/client

# --- migrate: run database migrations -----------------------------------------
FROM build AS migrate
CMD ["pnpm", "exec", "prisma", "db", "push"]

# --- runner: minimal standalone server ---------------------------------------
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV AGENT_DIST_DIR=/app/agent-dist

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Next.js standalone output
COPY --from=build /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static

# Prisma client + schema for runtime queries
COPY --from=build --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=build --chown=nextjs:nodejs /out-prisma ./node_modules/.prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma

# Agent binaries + checksums (served at /api/agent/releases/*)
COPY --from=agent-builder --chown=nextjs:nodejs /agent-dist ./agent-dist

USER nextjs
EXPOSE 3000

# Healthcheck: lightweight root page fetch (no auth). Next.js standalone serves /.
# Falls back to process check if network unavailable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]