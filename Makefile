# NexOPS Root Makefile
# Provides common development and deployment targets.

.PHONY: dev build agent up down logs db-push fmt lint typecheck test-agent clean help

# Default target
help:
	@echo "NexOPS Makefile targets:"
	@echo "  dev         - Run Next.js dev server (pnpm dev)"
	@echo "  build       - Build Docker image (multi-stage: deps, agent-builder, build, runner)"
	@echo "  agent       - Build agent binaries locally into ./agent-dist via Docker"
	@echo "  up          - Start all services (docker compose up -d --build)"
	@echo "  down        - Stop and remove all services (docker compose down)"
	@echo "  logs        - Follow logs from all services (docker compose logs -f)"
	@echo "  db-push     - Run prisma db push against local database"
	@echo "  fmt         - Format code (prettier + go fmt)"
	@echo "  lint        - Lint code (eslint + go vet)"
	@echo "  typecheck   - TypeScript type check (tsc --noEmit)"
	@echo "  test-agent  - Run Go agent unit tests in Docker"
	@echo "  clean       - Remove build artifacts and Docker volumes"

# Development
dev:
	pnpm dev

# Docker image build
build:
	docker build -t nexops:latest .

# Build agent binaries locally into ./agent-dist using Docker
agent:
	docker build --target agent-builder -t nexops-agent-builder:local . \
	&& rm -rf ./agent-dist && mkdir -p ./agent-dist \
	&& cid=$$(docker create nexops-agent-builder:local) \
	&& docker cp $$cid:/agent-dist/. ./agent-dist/; \
	ec=$$?; docker rm -f $$cid >/dev/null; exit $$ec

# Docker Compose operations
up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f

# Database
db-push:
	docker compose run --rm migrate

# Code quality
fmt:
	pnpm exec prettier --write .
	cd agent && go fmt ./...

lint:
	pnpm lint
	cd agent && go vet ./...

typecheck:
	pnpm typecheck

# Run Go agent unit tests in Docker
test-agent:
	docker run --rm -v $(PWD)/agent:/src -w /src golang:1.22-alpine go test ./...

# Cleanup
clean:
	rm -rf .next node_modules agent-dist
	docker compose down -v
	docker image rm -f nexops-agent-builder:local
	docker image prune -f
