// Package enrol performs first-start enrolment: generate the Ed25519 keypair,
// prove possession of the enrolment token, persist the issued credential, and
// scrub the token from disk.
package enrol

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"os"
	"runtime"
	"strings"

	"github.com/nexops/agent/internal/config"
	"github.com/nexops/agent/internal/metrics"
	"github.com/nexops/agent/internal/protocol"
)

// Ensure enrols the agent if state has no credential yet. Idempotent: when a
// credential is already stored this is a no-op, so restarts never consume a
// second token (tokens are single-use).
func Ensure(ctx context.Context, cfg *config.Config, st *config.State, client *protocol.Client, agentVersion string) error {
	if st.Credential != "" && st.AgentID != "" {
		return nil
	}
	if cfg.EnrolToken == "" {
		return fmt.Errorf("agent is not enrolled and ENROL_TOKEN is missing from %s", cfg.EnvPath)
	}

	priv, err := config.LoadOrCreateKey(cfg.StateDir)
	if err != nil {
		return err
	}

	hostname, err := os.Hostname()
	if err != nil {
		return fmt.Errorf("read hostname: %w", err)
	}
	family, osVersion, err := resolveOS(cfg)
	if err != nil {
		return err
	}

	req := protocol.EnrolRequest{
		Token: cfg.EnrolToken,
		// base64.StdEncoding matches TypeScript Buffer.from(...).toString("base64").
		PublicKey:    base64.StdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey)),
		Hostname:     hostname,
		OS:           family,
		Arch:         runtime.GOARCH,
		OSVersion:    osVersion,
		AgentVersion: agentVersion,
		Signature:    base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte(cfg.EnrolToken))),
	}

	resp, err := client.Enrol(ctx, req)
	if err != nil {
		return fmt.Errorf("enrol: %w", err)
	}
	if resp.AgentID == "" || resp.Credential == "" {
		return fmt.Errorf("enrol: control plane response missing agentId/credential")
	}
	interval := resp.HeartbeatIntervalSec
	if interval <= 0 {
		interval = config.DefaultHeartbeatIntervalSec
	}

	*st = config.State{
		AgentID:              resp.AgentID,
		TargetID:             resp.TargetID,
		Credential:           resp.Credential,
		ControlPlaneURL:      cfg.ControlPlaneURL,
		HeartbeatIntervalSec: interval,
	}
	if err := config.SaveState(cfg.StateDir, *st); err != nil {
		return fmt.Errorf("enrol: persist state: %w", err)
	}
	// The token is single-use and now consumed; remove it from disk so a
	// leaked agent.env no longer carries a (dead but sensitive) token.
	if err := cfg.ScrubEnrolToken(); err != nil {
		return fmt.Errorf("enrol: %w", err)
	}
	return nil
}

// resolveOS picks the OsFamily enum value: explicit config wins, otherwise
// derive from /etc/os-release. osVersion is VERSION_ID (e.g. "24.04").
func resolveOS(cfg *config.Config) (family, version string, err error) {
	info, osErr := metrics.DetectOS()
	if osErr == nil {
		version = info.VersionID
	}
	family = cfg.OS
	if family == "" {
		if osErr != nil {
			return "", "", fmt.Errorf("OS not set in %s and %s", cfg.EnvPath, osErr)
		}
		family = info.Family()
		if family == "" {
			id := strings.ToLower(info.ID)
			if id == "" {
				id = "(unrecognised)"
			}
			return "", "", fmt.Errorf("OS not set in %s and os-release ID %q is not ubuntu/debian", cfg.EnvPath, id)
		}
	}
	return family, version, nil
}
