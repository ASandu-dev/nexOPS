// Package config loads /etc/nexops/agent.env and persists agent state under
// AGENT_STATE_DIR. The env file is plain KEY=VALUE lines — never executed by a
// shell — and is rewritten (without ENROL_TOKEN) after successful enrolment so
// the single-use token no longer sits on disk.
package config

import (
	"bufio"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/nexops/agent/internal/units"
)

const (
	// DefaultEnvPath is where install.sh writes the agent configuration.
	DefaultEnvPath = "/etc/nexops/agent.env"
	// DefaultStateDir holds state.json and the Ed25519 private key.
	DefaultStateDir = "/var/lib/nexops"
	// DefaultHeartbeatIntervalSec matches the control plane default.
	DefaultHeartbeatIntervalSec = 30

	// KeyFileName stores the PEM-encoded Ed25519 private key (mode 0600).
	KeyFileName = "key.pem"
	// StateFileName stores the issued credential (mode 0600).
	StateFileName = "state.json"

	minHeartbeatSec = 5
	maxHeartbeatSec = 3600
)

// DefaultWatchedServices is used when WATCHED_SERVICES is absent from
// agent.env. Both ssh and sshd are listed because the unit name differs
// between Debian and RHEL-derived systems; the missing one reports
// "not-found" and is harmless.
var DefaultWatchedServices = []string{"ssh", "sshd", "cron", "systemd-journald"}

// Config is the parsed agent.env plus the raw lines needed to rewrite the file.
type Config struct {
	ControlPlaneURL      string
	EnrolToken           string
	OS                   string // "UBUNTU" | "DEBIAN" | "" (resolved from os-release at enrol time)
	StateDir             string
	HeartbeatIntervalSec int // 0 = fall back to the enrol response / default
	WatchedServices      []string
	EnvPath              string

	lines []envLine
}

type envLine struct {
	raw string
	key string // empty for comments / malformed lines
}

// Load reads and validates the env file. A missing file is a hard error: the
// agent cannot discover its control plane without it.
func Load(path string) (Config, error) {
	f, err := os.Open(path)
	if err != nil {
		return Config{}, fmt.Errorf("open config %s: %w (run install.sh first)", path, err)
	}
	defer f.Close()

	cfg := Config{EnvPath: path, StateDir: DefaultStateDir}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 4096), 1<<20)
	for sc.Scan() {
		raw := sc.Text()
		line := envLine{raw: raw}
		trimmed := strings.TrimSpace(raw)
		if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			if eq := strings.IndexByte(trimmed, '='); eq > 0 {
				line.key = strings.TrimSpace(trimmed[:eq])
				val := unquote(strings.TrimSpace(trimmed[eq+1:]))
				switch line.key {
				case "CONTROL_PLANE_URL":
					cfg.ControlPlaneURL = val
				case "ENROL_TOKEN":
					cfg.EnrolToken = val
				case "OS":
					cfg.OS = strings.ToUpper(strings.TrimSpace(val))
				case "AGENT_STATE_DIR":
					if val != "" {
						cfg.StateDir = val
					}
				case "HEARTBEAT_INTERVAL_SEC":
					n, err := strconv.Atoi(val)
					if err != nil || n < minHeartbeatSec || n > maxHeartbeatSec {
						return Config{}, fmt.Errorf("HEARTBEAT_INTERVAL_SEC must be an integer between %d and %d, got %q", minHeartbeatSec, maxHeartbeatSec, val)
					}
					cfg.HeartbeatIntervalSec = n
				case "WATCHED_SERVICES":
					cfg.WatchedServices = splitList(val)
				}
			}
		}
		cfg.lines = append(cfg.lines, line)
	}
	if err := sc.Err(); err != nil {
		return Config{}, fmt.Errorf("read config %s: %w", path, err)
	}

	if cfg.ControlPlaneURL == "" {
		return Config{}, fmt.Errorf("CONTROL_PLANE_URL missing from %s", path)
	}
	if u, err := url.Parse(cfg.ControlPlaneURL); err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return Config{}, fmt.Errorf("CONTROL_PLANE_URL %q in %s must be an https:// URL (http:// allowed for local dev only)", cfg.ControlPlaneURL, path)
	}
	if cfg.OS != "" && cfg.OS != "UBUNTU" && cfg.OS != "DEBIAN" {
		return Config{}, fmt.Errorf("OS must be UBUNTU or DEBIAN, got %q", cfg.OS)
	}
	if cfg.WatchedServices == nil {
		cfg.WatchedServices = append([]string(nil), DefaultWatchedServices...)
	}
	for _, svc := range cfg.WatchedServices {
		if !units.ValidName(svc) {
			return Config{}, fmt.Errorf("invalid service name %q in WATCHED_SERVICES", svc)
		}
	}
	return cfg, nil
}

// ScrubEnrolToken rewrites the env file without any ENROL_TOKEN line, keeping
// every other line (including comments) byte-for-byte. Idempotent.
func (c *Config) ScrubEnrolToken() error {
	var out []string
	changed := false
	for _, l := range c.lines {
		if l.key == "ENROL_TOKEN" {
			changed = true
			continue
		}
		out = append(out, l.raw)
	}
	if !changed {
		return nil
	}
	mode := os.FileMode(0o600)
	if st, err := os.Stat(c.EnvPath); err == nil {
		mode = st.Mode().Perm()
	}
	if err := writeFileAtomic(c.EnvPath, []byte(strings.Join(out, "\n")+"\n"), mode); err != nil {
		return fmt.Errorf("scrub ENROL_TOKEN from %s: %w", c.EnvPath, err)
	}
	c.EnrolToken = ""
	return nil
}

// unquote strips one layer of matching single or double quotes. No shell
// semantics (expansion, escapes) are applied.
func unquote(v string) string {
	if len(v) >= 2 {
		if (v[0] == '"' && v[len(v)-1] == '"') || (v[0] == '\'' && v[len(v)-1] == '\'') {
			return v[1 : len(v)-1]
		}
	}
	return v
}

func splitList(v string) []string {
	var out []string
	for _, part := range strings.Split(v, ",") {
		p := strings.TrimSpace(part)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

// State is what the agent needs to resume after enrolment. Stored at
// $AGENT_STATE_DIR/state.json, mode 0600.
type State struct {
	AgentID              string `json:"agentId"`
	TargetID             string `json:"targetId"`
	Credential           string `json:"credential"`
	ControlPlaneURL      string `json:"controlPlaneURL"`
	HeartbeatIntervalSec int    `json:"heartbeatIntervalSec"`
}

// LoadState reads state.json; a missing file yields a zero State (not an
// error) so the agent can enrol on first start.
func LoadState(dir string) (State, error) {
	raw, err := os.ReadFile(filepath.Join(dir, StateFileName))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return State{}, nil
		}
		return State{}, fmt.Errorf("read state %s: %w", dir, err)
	}
	var st State
	if err := json.Unmarshal(raw, &st); err != nil {
		return State{}, fmt.Errorf("parse %s: %w", filepath.Join(dir, StateFileName), err)
	}
	return st, nil
}

// MatchesControlPlane reports whether the stored identity was issued by
// controlPlaneURL. URLs are compared after trimming surrounding whitespace
// and trailing slashes. The env file (root-owned) is authoritative: a
// mismatch means the credential belongs to a different control plane and
// must be discarded, not retried.
func (s *State) MatchesControlPlane(controlPlaneURL string) bool {
	if s.ControlPlaneURL == "" {
		return false
	}
	return normalizeControlPlaneURL(s.ControlPlaneURL) == normalizeControlPlaneURL(controlPlaneURL)
}

func normalizeControlPlaneURL(u string) string {
	return strings.TrimRight(strings.TrimSpace(u), "/")
}

// SaveState persists state atomically (temp file + rename) with mode 0600.
func SaveState(dir string, st State) error {
	raw, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(dir, StateFileName), raw, 0o600)
}

// LoadOrCreateKey returns the persisted Ed25519 private key, generating and
// saving a new one (mode 0600) on first start. Accepts PKCS#8 PEM (written by
// this agent) as well as raw 64-byte or 32-byte seed keys for flexibility.
func LoadOrCreateKey(dir string) (ed25519.PrivateKey, error) {
	path := filepath.Join(dir, KeyFileName)
	raw, err := os.ReadFile(path)
	if err == nil {
		return parseKey(raw)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	_, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		return nil, fmt.Errorf("generate ed25519 key: %w", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, fmt.Errorf("marshal private key: %w", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	if err := writeFileAtomic(path, pemBytes, 0o600); err != nil {
		return nil, fmt.Errorf("persist private key: %w", err)
	}
	return priv, nil
}

func parseKey(raw []byte) (ed25519.PrivateKey, error) {
	if block, _ := pem.Decode(raw); block != nil {
		k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse key.pem: %w", err)
		}
		priv, ok := k.(ed25519.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("key.pem does not contain an ed25519 key")
		}
		return priv, nil
	}
	trimmed := strings.TrimSpace(string(raw))
	switch len(trimmed) {
	case ed25519.SeedSize:
		return ed25519.NewKeyFromSeed([]byte(trimmed)), nil
	case ed25519.PrivateKeySize:
		priv := ed25519.PrivateKey([]byte(trimmed))
		// Sanity-check the embedded public half.
		pub := priv.Public().(ed25519.PublicKey)
		if len(priv) == ed25519.PrivateKeySize && string(priv[32:]) == string(pub) {
			return priv, nil
		}
	}
	return nil, fmt.Errorf("key material is not a valid ed25519 key")
}

// writeFileAtomic writes data to path via a temp file in the same directory,
// then renames over the destination. The temp file carries the final mode from
// the start so secrets are never briefly world-readable.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after successful rename
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}
