GO      ?= go
VERSION ?= 0.1.0
DIST    ?= ../agent-dist
LDFLAGS := -s -w -X main.version=$(VERSION)
BIN     := nexops-agent-linux

.PHONY: build vet test clean

## build: cross-compile static amd64+arm64 binaries into $(DIST) with sha256 sidecars
build:
	@mkdir -p $(DIST)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build -trimpath -buildvcs=false -ldflags "$(LDFLAGS)" -o $(DIST)/$(BIN)-amd64 ./cmd/nexops-agent
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 $(GO) build -trimpath -buildvcs=false -ldflags "$(LDFLAGS)" -o $(DIST)/$(BIN)-arm64 ./cmd/nexops-agent
	cd $(DIST) && sha256sum $(BIN)-amd64 > $(BIN)-amd64.sha256 && sha256sum $(BIN)-arm64 > $(BIN)-arm64.sha256

## vet: run go vet on all packages
vet:
	$(GO) vet ./...

## test: run the unit tests
test:
	$(GO) test ./...

## clean: remove build artifacts produced by this Makefile
clean:
	rm -f $(DIST)/$(BIN)-amd64 $(DIST)/$(BIN)-arm64 $(DIST)/$(BIN)-amd64.sha256 $(DIST)/$(BIN)-arm64.sha256
