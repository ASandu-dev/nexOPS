// Package selfupdate implements the SELF_UPDATE job: it downloads the agent
// release for the host's architecture from the control plane, verifies it
// against the published SHA-256 sidecar and atomically replaces the running
// binary.
//
// Trust anchor: the release endpoint of the control plane the agent already
// talks to (CONTROL_PLANE_URL) — the same origin install.sh uses. No
// caller-supplied URL is ever contacted.
package selfupdate

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	// AssetPrefix is the file name prefix of the published agent binaries.
	AssetPrefix = "nexops-agent-linux-"
	// ChecksumSuffix is the suffix of the published checksum sidecar.
	ChecksumSuffix = ".sha256"
	// BinaryMode is the mode of the installed agent binary.
	BinaryMode os.FileMode = 0o755
	// digestHexLen is the length of a SHA-256 digest in hex characters.
	digestHexLen = 64
	// versionProbeTimeout bounds the `version` probe of the new binary.
	versionProbeTimeout = 10 * time.Second
	// unknownVersion is reported when the new binary cannot be interrogated.
	unknownVersion = "unknown"
)

// Fetcher downloads a release artefact by file name. *protocol.Client
// implements it; the interface keeps this package free of HTTP details.
type Fetcher interface {
	Release(ctx context.Context, file string) ([]byte, error)
}

// AssetName returns the published release file name for a GOARCH.
func AssetName(arch string) (string, error) {
	switch arch {
	case "amd64", "arm64":
		return AssetPrefix + arch, nil
	default:
		return "", fmt.Errorf("unsupported architecture %q: expected amd64 or arm64", arch)
	}
}

// ParseChecksum parses a `sha256sum` sidecar for the named file.
//
// The format is "<64 hex characters>  <file name>" (two spaces, as produced
// by sha256sum); the binary-mode marker '*' in front of the name is accepted
// as well. Anything else is rejected: a sidecar that does not describe the
// file that was downloaded must never be able to pass verification.
func ParseChecksum(sidecar []byte, fileName string) (string, error) {
	text := strings.TrimSpace(string(sidecar))
	if text == "" {
		return "", errors.New("checksum file is empty")
	}
	// sha256sum writes exactly one line; ignore anything after it.
	if idx := strings.IndexByte(text, '\n'); idx >= 0 {
		text = strings.TrimSpace(text[:idx])
	}
	fields := strings.Fields(text)
	if len(fields) != 2 {
		return "", errors.New(`malformed checksum file: expected "<sha256>  <file>"`)
	}
	digest := strings.ToLower(fields[0])
	name := strings.TrimPrefix(fields[1], "*")
	if name != fileName {
		return "", fmt.Errorf("checksum file describes %q, expected %q", name, fileName)
	}
	if len(digest) != digestHexLen {
		return "", fmt.Errorf("malformed checksum: expected %d hex characters, got %d", digestHexLen, len(digest))
	}
	if _, err := hex.DecodeString(digest); err != nil {
		return "", fmt.Errorf("malformed checksum: %w", err)
	}
	return digest, nil
}

// VerifyDigest checks data against the expected hex SHA-256 digest. The
// comparison is constant time, so a mismatch leaks nothing about the digest.
func VerifyDigest(data []byte, want string) error {
	sum := sha256.Sum256(data)
	got := hex.EncodeToString(sum[:])
	if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
		return errors.New("checksum mismatch: the downloaded file does not match the published digest")
	}
	return nil
}

// FileDigest returns the hex SHA-256 digest of a file.
func FileDigest(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Install replaces the file at path with data.
//
// The new binary is written to a temporary file in the same directory (so the
// rename is atomic), flushed to disk and only then renamed over the target.
// The old binary is left untouched unless the rename succeeds.
func Install(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".nexops-agent-*")
	if err != nil {
		return fmt.Errorf("create temporary file in %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName) // no-op once the rename succeeded
	}()
	if err := tmp.Chmod(mode); err != nil {
		return fmt.Errorf("set mode on %s: %w", tmpName, err)
	}
	if _, err := tmp.Write(data); err != nil {
		return fmt.Errorf("write %s: %w", tmpName, err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("flush %s: %w", tmpName, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close %s: %w", tmpName, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("replace %s: %w", path, err)
	}
	// Flush the directory entry so the swap survives a crash.
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// Options configures an Updater.
type Options struct {
	// Fetcher downloads the release artefacts (same origin as the agent's
	// control-plane connection).
	Fetcher Fetcher
	// Arch is the architecture of the running binary; defaults to runtime.GOARCH.
	Arch string
	// Version is the version of the running agent.
	Version string
	// ExecPath overrides the resolved executable path (tests).
	ExecPath string
	// Logger receives progress messages; optional.
	Logger *log.Logger
}

// Outcome is the result of a self-update attempt.
type Outcome struct {
	// Message is the operator-facing description of what happened.
	Message string
	// Err is non-nil when the update failed. Nothing was written in that case.
	Err error
	// RestartPath is the binary to exec once the result has been reported.
	// Empty when no restart is needed.
	RestartPath string
}

// Updater installs a new agent release over the running binary.
type Updater struct {
	opts Options
}

// New returns an Updater for the given options.
func New(opts Options) *Updater {
	return &Updater{opts: opts}
}

// Run downloads, verifies and installs the latest release for this host.
//
// No failure path modifies the running binary: the download is verified
// before anything is written, and the write itself is atomic.
func (u *Updater) Run(ctx context.Context) Outcome {
	name, err := AssetName(u.arch())
	if err != nil {
		return failure(err)
	}
	if u.opts.Fetcher == nil {
		return failure(errors.New("no release source configured"))
	}

	u.logf("downloading %s", name)
	binary, err := u.opts.Fetcher.Release(ctx, name)
	if err != nil {
		return failure(fmt.Errorf("download %s: %w", name, err))
	}
	sidecar, err := u.opts.Fetcher.Release(ctx, name+ChecksumSuffix)
	if err != nil {
		return failure(fmt.Errorf("download %s: %w", name+ChecksumSuffix, err))
	}

	want, err := ParseChecksum(sidecar, name)
	if err != nil {
		return failure(fmt.Errorf("invalid checksum file: %w", err))
	}
	if err := VerifyDigest(binary, want); err != nil {
		return failure(err)
	}
	u.logf("checksum verified for %s", name)

	exe, err := u.executablePath()
	if err != nil {
		return failure(err)
	}

	// Short-circuit: the running binary is already the published release.
	current, err := FileDigest(exe)
	if err == nil && subtle.ConstantTimeCompare([]byte(current), []byte(want)) == 1 {
		return Outcome{Message: fmt.Sprintf("already up to date (%s)", u.version())}
	}

	if err := Install(exe, binary, BinaryMode); err != nil {
		return failure(fmt.Errorf("install %s: %w — the agent needs write access to %s "+
			"(run the agent from a directory it owns, or grant the %q group write access to it)",
			name, err, filepath.Dir(exe), "nexops-agent"))
	}

	newVersion := detectVersion(ctx, exe)
	return Outcome{
		Message:     fmt.Sprintf("installed %s (old %s), restarting agent", newVersion, u.version()),
		RestartPath: exe,
	}
}

// executablePath resolves the binary that is currently running. On Linux
// os.Executable reads /proc/self/exe, i.e. the file on disk — the very file
// the update replaces.
func (u *Updater) executablePath() (string, error) {
	if u.opts.ExecPath != "" {
		return u.opts.ExecPath, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve the running executable: %w", err)
	}
	// A replaced (unlinked) binary shows up as "<path> (deleted)".
	exe = strings.TrimSuffix(exe, " (deleted)")
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil {
		// Fall back to the unresolved path: it is still the file the process
		// was started from.
		return exe, nil
	}
	return resolved, nil
}

func (u *Updater) arch() string {
	if u.opts.Arch != "" {
		return u.opts.Arch
	}
	return runtime.GOARCH
}

func (u *Updater) version() string {
	if u.opts.Version == "" {
		return unknownVersion
	}
	return u.opts.Version
}

func (u *Updater) logf(format string, args ...any) {
	if u.opts.Logger == nil {
		return
	}
	u.opts.Logger.Printf(format, args...)
}

// detectVersion asks the installed binary for its version. A failure is not
// fatal: the update itself already succeeded.
func detectVersion(ctx context.Context, path string) string {
	cctx, cancel := context.WithTimeout(ctx, versionProbeTimeout)
	defer cancel()
	out, err := exec.CommandContext(cctx, path, "version").Output()
	if err != nil {
		return unknownVersion
	}
	// "nexops-agent 0.1.0 (linux/amd64)"
	fields := strings.Fields(string(out))
	if len(fields) >= 2 && fields[0] == "nexops-agent" {
		return fields[1]
	}
	return unknownVersion
}

func failure(err error) Outcome {
	return Outcome{Message: err.Error(), Err: err}
}
