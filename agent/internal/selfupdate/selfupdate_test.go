package selfupdate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nexops/agent/internal/protocol"
)

// fakeFetcher serves release artefacts from an in-memory map.
type fakeFetcher struct {
	files map[string][]byte
	err   error
	calls []string
}

func (f *fakeFetcher) Release(_ context.Context, file string) ([]byte, error) {
	f.calls = append(f.calls, file)
	if f.err != nil {
		return nil, f.err
	}
	data, ok := f.files[file]
	if !ok {
		return nil, fmt.Errorf("release %q not found", file)
	}
	return data, nil
}

// sidecarFor builds a `sha256sum` sidecar for data.
func sidecarFor(data []byte, name string) []byte {
	sum := sha256.Sum256(data)
	return []byte(fmt.Sprintf("%s  %s\n", hex.EncodeToString(sum[:]), name))
}

// fakeAgentScript returns a shell script that answers the `version` probe
// like the real agent binary does.
func fakeAgentScript(version string) []byte {
	return []byte(fmt.Sprintf("#!/bin/sh\necho 'nexops-agent %s (linux/amd64)'\n", version))
}

func TestAssetNameMapsArchToReleaseFile(t *testing.T) {
	cases := map[string]string{
		"amd64": "nexops-agent-linux-amd64",
		"arm64": "nexops-agent-linux-arm64",
	}
	for arch, want := range cases {
		got, err := AssetName(arch)
		if err != nil {
			t.Fatalf("%s: %v", arch, err)
		}
		if got != want {
			t.Errorf("%s → %q, want %q", arch, got, want)
		}
	}
	for _, arch := range []string{"", "386", "arm", "riscv64", "AMD64", "amd64/../etc"} {
		if _, err := AssetName(arch); err == nil {
			t.Errorf("%q must be rejected", arch)
		}
	}
}

func TestParseChecksum(t *testing.T) {
	digest := strings.Repeat("a", 64)
	const name = "nexops-agent-linux-amd64"

	got, err := ParseChecksum([]byte(digest+"  "+name+"\n"), name)
	if err != nil {
		t.Fatalf("valid sidecar rejected: %v", err)
	}
	if got != digest {
		t.Fatalf("digest = %q, want %q", got, digest)
	}

	// sha256sum's binary-mode marker is accepted.
	if _, err := ParseChecksum([]byte(digest+" *"+name+"\n"), name); err != nil {
		t.Fatalf("binary-mode sidecar rejected: %v", err)
	}

	// A sidecar describing another file must never verify our download.
	if _, err := ParseChecksum([]byte(digest+"  nexops-agent-linux-arm64\n"), name); err == nil {
		t.Fatal("a sidecar for another file must be rejected")
	}

	// Malformed hex.
	if _, err := ParseChecksum([]byte(strings.Repeat("z", 64)+"  "+name+"\n"), name); err == nil {
		t.Fatal("a non-hex digest must be rejected")
	}

	// Wrong digest length.
	if _, err := ParseChecksum([]byte(strings.Repeat("a", 63)+"  "+name+"\n"), name); err == nil {
		t.Fatal("a short digest must be rejected")
	}
	if _, err := ParseChecksum([]byte(strings.Repeat("a", 65)+"  "+name+"\n"), name); err == nil {
		t.Fatal("a long digest must be rejected")
	}

	// Structurally broken sidecars.
	for _, sidecar := range []string{"", "   \n", "garbage\n", digest + "\n", digest + "  " + name + "  extra\n"} {
		if _, err := ParseChecksum([]byte(sidecar), name); err == nil {
			t.Errorf("malformed sidecar %q must be rejected", sidecar)
		}
	}
}

func TestVerifyDigestRejectsMismatch(t *testing.T) {
	data := []byte("payload")
	sum := sha256.Sum256(data)
	if err := VerifyDigest(data, hex.EncodeToString(sum[:])); err != nil {
		t.Fatalf("matching digest rejected: %v", err)
	}
	if err := VerifyDigest([]byte("other"), hex.EncodeToString(sum[:])); err == nil {
		t.Fatal("a mismatching digest must be rejected")
	}
}

// TestUpdaterShortCircuitsWhenAlreadyUpToDate: the running binary is already
// the published release, so nothing is written and no restart is requested.
func TestUpdaterShortCircuitsWhenAlreadyUpToDate(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "nexops-agent")
	current := fakeAgentScript("1.2.3")
	if err := os.WriteFile(exe, current, 0o755); err != nil {
		t.Fatal(err)
	}

	fetcher := &fakeFetcher{files: map[string][]byte{
		"nexops-agent-linux-amd64":        current,
		"nexops-agent-linux-amd64.sha256": sidecarFor(current, "nexops-agent-linux-amd64"),
	}}
	out := New(Options{Fetcher: fetcher, Arch: "amd64", Version: "1.2.3", ExecPath: exe}).
		Run(context.Background())

	if out.Err != nil {
		t.Fatalf("unexpected error: %v", out.Err)
	}
	if out.Message != "already up to date (1.2.3)" {
		t.Fatalf("message = %q", out.Message)
	}
	if out.RestartPath != "" {
		t.Fatalf("restart path = %q, want none", out.RestartPath)
	}
	onDisk, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(onDisk, current) {
		t.Fatal("the running binary must not be touched")
	}
}

// TestUpdaterInstallsVerifiedRelease covers the happy path: the verified
// binary replaces the running one and a restart is requested.
func TestUpdaterInstallsVerifiedRelease(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "nexops-agent")
	if err := os.WriteFile(exe, []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	released := fakeAgentScript("2.0.0")
	fetcher := &fakeFetcher{files: map[string][]byte{
		"nexops-agent-linux-amd64":        released,
		"nexops-agent-linux-amd64.sha256": sidecarFor(released, "nexops-agent-linux-amd64"),
	}}
	out := New(Options{Fetcher: fetcher, Arch: "amd64", Version: "1.2.3", ExecPath: exe}).
		Run(context.Background())

	if out.Err != nil {
		t.Fatalf("unexpected error: %v", out.Err)
	}
	if out.Message != "installed 2.0.0 (old 1.2.3), restarting agent" {
		t.Fatalf("message = %q", out.Message)
	}
	if out.RestartPath != exe {
		t.Fatalf("restart path = %q, want %q", out.RestartPath, exe)
	}
	onDisk, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(onDisk, released) {
		t.Fatal("the new binary was not installed")
	}
	info, err := os.Stat(exe)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("mode = %v, want 0755", info.Mode().Perm())
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
}

// TestUpdaterRejectsChecksumMismatch: a tampered download fails the job and
// leaves the running binary untouched.
func TestUpdaterRejectsChecksumMismatch(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "nexops-agent")
	original := []byte("old binary")
	if err := os.WriteFile(exe, original, 0o755); err != nil {
		t.Fatal(err)
	}

	fetcher := &fakeFetcher{files: map[string][]byte{
		"nexops-agent-linux-amd64":        []byte("tampered"),
		"nexops-agent-linux-amd64.sha256": sidecarFor([]byte("expected"), "nexops-agent-linux-amd64"),
	}}
	out := New(Options{Fetcher: fetcher, Arch: "amd64", Version: "1.2.3", ExecPath: exe}).
		Run(context.Background())

	if out.Err == nil {
		t.Fatal("a checksum mismatch must fail the update")
	}
	if out.RestartPath != "" {
		t.Fatalf("restart path = %q, want none", out.RestartPath)
	}
	onDisk, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(onDisk, original) {
		t.Fatal("the running binary must be untouched after a verification failure")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
}

// TestUpdaterReportsDownloadFailure: a control plane that does not serve the
// release fails the job with an actionable message.
func TestUpdaterReportsDownloadFailure(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "nexops-agent")
	if err := os.WriteFile(exe, []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	fetcher := &fakeFetcher{files: map[string][]byte{}}
	out := New(Options{Fetcher: fetcher, Arch: "amd64", Version: "1.2.3", ExecPath: exe}).
		Run(context.Background())

	if out.Err == nil {
		t.Fatal("a missing release must fail the update")
	}
	if !strings.Contains(out.Message, "download nexops-agent-linux-amd64") {
		t.Fatalf("message = %q", out.Message)
	}
	if out.RestartPath != "" {
		t.Fatalf("restart path = %q, want none", out.RestartPath)
	}
}

// TestUpdaterRejectsUnsupportedArch: an architecture without a published
// release fails instead of downloading the wrong binary.
func TestUpdaterRejectsUnsupportedArch(t *testing.T) {
	fetcher := &fakeFetcher{files: map[string][]byte{}}
	out := New(Options{Fetcher: fetcher, Arch: "386", Version: "1.0.0"}).Run(context.Background())
	if out.Err == nil {
		t.Fatal("an unsupported architecture must fail the update")
	}
	if !strings.Contains(out.Message, "unsupported architecture") {
		t.Fatalf("message = %q", out.Message)
	}
	if len(fetcher.calls) != 0 {
		t.Fatalf("nothing must be downloaded for an unsupported architecture: %v", fetcher.calls)
	}
}

// TestUpdaterDownloadsFromControlPlane proves the release is fetched from the
// control plane origin (the same one install.sh trusts), through the agent's
// HTTP client.
func TestUpdaterDownloadsFromControlPlane(t *testing.T) {
	released := fakeAgentScript("3.1.4")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agent/releases/nexops-agent-linux-amd64":
			_, _ = w.Write(released)
		case "/api/agent/releases/nexops-agent-linux-amd64.sha256":
			_, _ = w.Write(sidecarFor(released, "nexops-agent-linux-amd64"))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	client, err := protocol.NewClient(srv.URL)
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	exe := filepath.Join(dir, "nexops-agent")
	if err := os.WriteFile(exe, []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	out := New(Options{Fetcher: client, Arch: "amd64", Version: "3.0.0", ExecPath: exe}).
		Run(context.Background())
	if out.Err != nil {
		t.Fatalf("unexpected error: %v", out.Err)
	}
	if out.Message != "installed 3.1.4 (old 3.0.0), restarting agent" {
		t.Fatalf("message = %q", out.Message)
	}
	if out.RestartPath != exe {
		t.Fatalf("restart path = %q, want %q", out.RestartPath, exe)
	}
}

// TestInstallReadOnlyDirectoryLeavesOldBinaryIntact: the swap fails on a
// read-only filesystem and the old binary survives.
func TestInstallReadOnlyDirectoryLeavesOldBinaryIntact(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: directory permissions are not enforced")
	}
	dir := t.TempDir()
	target := filepath.Join(dir, "nexops-agent")
	old := []byte("old binary")
	if err := os.WriteFile(target, old, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chmod(dir, 0o700) }()

	if err := Install(target, []byte("new binary"), 0o755); err == nil {
		t.Fatal("installing into a read-only directory must fail")
	}
	onDisk, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(onDisk, old) {
		t.Fatal("the old binary must be untouched")
	}
}

// TestInstallRenameFailureLeavesTargetIntact: the rename fails (the target
// is a directory), the old entry survives and no temporary file is left.
func TestInstallRenameFailureLeavesTargetIntact(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "nexops-agent")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := Install(target, []byte("new binary"), 0o755); err == nil {
		t.Fatal("replacing a directory must fail")
	}
	info, err := os.Stat(target)
	if err != nil || !info.IsDir() {
		t.Fatal("the existing entry must be untouched")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
}

// TestInstallMissingDirectoryFails: the temporary file cannot even be created,
// so nothing is written anywhere.
func TestInstallMissingDirectoryFails(t *testing.T) {
	target := filepath.Join(t.TempDir(), "missing", "nexops-agent")
	if err := Install(target, []byte("new binary"), 0o755); err == nil {
		t.Fatal("installing into a missing directory must fail")
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("nothing must have been created")
	}
}
