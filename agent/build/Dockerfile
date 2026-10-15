# Builds the static NexOPS agent for linux/amd64 and linux/arm64 and stages the
# binaries (plus checksums) in /dist. The control plane copies them into
# AGENT_DIST_DIR by building with:
#
#   docker build --target dist --output type=local,dest=./agent-dist agent/
#
# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS build
ARG VERSION=0.1.0
WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
      go build -trimpath -buildvcs=false -ldflags "-s -w -X main.version=${VERSION}" \
      -o /out/nexops-agent-linux-amd64 ./cmd/nexops-agent \
 && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
      go build -trimpath -buildvcs=false -ldflags "-s -w -X main.version=${VERSION}" \
      -o /out/nexops-agent-linux-arm64 ./cmd/nexops-agent \
 && cd /out \
 && sha256sum nexops-agent-linux-amd64 > nexops-agent-linux-amd64.sha256 \
 && sha256sum nexops-agent-linux-arm64 > nexops-agent-linux-arm64.sha256

# The dist stage only carries build artifacts; it is exported to a local
# directory, never shipped as a runtime image.
FROM scratch AS dist
COPY --from=build /out/ /
