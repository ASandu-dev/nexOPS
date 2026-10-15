// nexops-agent is the outbound-only fleet agent. It enrols once against the
// control plane, then heartbeats telemetry and executes dispatched jobs.
//
// Usage:
//
//	nexops-agent run      # default; runs the agent until SIGTERM/SIGINT
//	nexops-agent version  # prints version and build target
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime"
	"syscall"

	"github.com/nexops/agent/internal/agent"
	"github.com/nexops/agent/internal/config"
	"github.com/nexops/agent/internal/jobs"
	"github.com/nexops/agent/internal/metrics"
	"github.com/nexops/agent/internal/protocol"
)

// version is stamped at build time via -ldflags "-X main.version=…".
var version = "0.1.0"

func main() {
	cmd := "run"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "run":
		if err := run(); err != nil {
			log.Printf("fatal: %v", err)
			os.Exit(1)
		}
	case "version", "--version", "-v":
		fmt.Printf("nexops-agent %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
	case "help", "--help", "-h":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", cmd)
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `nexops-agent — NexOPS fleet agent (outbound-only)

Commands:
  run       Enrol (first start) and run the heartbeat loop until SIGTERM/SIGINT
  version   Print version and build target

Configuration is read from `+config.DefaultEnvPath+`; state is kept in
the agent state dir (default `+config.DefaultStateDir+`).
`)
}

func run() error {
	cfg, err := config.Load(config.DefaultEnvPath)
	if err != nil {
		return err
	}
	state, err := config.LoadState(cfg.StateDir)
	if err != nil {
		return err
	}
	client, err := protocol.NewClient(cfg.ControlPlaneURL)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	log.SetPrefix("nexops-agent: ")
	return agent.Run(ctx, agent.Options{
		Version:   version,
		Config:    &cfg,
		State:     &state,
		Client:    client,
		Collector: metrics.NewCollector(cfg.WatchedServices),
		Runner:    jobs.NewRunner(),
	})
}
