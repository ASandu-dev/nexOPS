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

// TestUpdaterInstallsVerifiedRelease covers the happy path: the staged binary
// passes its probe, replaces the running one, the previous build is kept as
// .prev and a restart is requested.
func TestUpdaterInstallsVerifiedRelease(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "nexops-agent")
	original := []byte("old binary")
	if err := os.WriteFile(exe, original, 0o755); err != nil {
		t.Fatal(err)
	}

	released := fakeAgentScript("2.0.0")
	fetcher := &fakeFetcher{files: map[string][]byte{
		"nexops-agent-linux-amd64":        released,
		"nexops-agent-linux-amd64.sha256": sidecarFor(released, "nexops-agent-linux-amd64"),
	}}
	out := New(Options{Fetcher: fetcher, Arch: "amd64", Version: "1.2.3", ExecPath: exe}).
		Run(context.Background())

	wantMessage := fmt.Sprintf("installed 2.0.0 (old 1.2.3), restarting agent; previous build saved as %s.prev", exe)
	if out.Err != nil {
		t.Fatalf("unexpected error: %v", out.Err)
	}
	if out.Message != wantMessage {
		t.Fatalf("message = %q, want %q", out.Message, wantMessage)
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
	previous, err := os.ReadFile(exe + ".prev")
	if err != nil {
		t.Fatalf("read previous build: %v", err)
	}
	if !bytes.Equal(previous, original) {
		t.Fatal(".prev must contain the replaced binary")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("unexpected files left behind: %v", entries)
	}
}

// TestUpdaterAbortsWhenStagedBinaryFailsProbe: a release that cannot run is
// refused before the swap, so the installed binary and its backup survive.
func TestUpdaterAbortsWhenStagedBinaryFailsProbe(t *testing.T) {
	cases := map[string][]byte{
		"non-zero exit": []byte("#!/bin/sh\nexit 1\n"),
		"exec failure":  []byte("this is not an executable"),
	}
	for name, released := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			exe := filepath.Join(dir, "nexops-agent")
			original := fakeAgentScript("1.2.3")
			if err := os.WriteFile(exe, original, 0o755); err != nil {
				t.Fatal(err)
			}

			fetcher := &fakeFetcher{files: map[string][]byte{
				"nexops-agent-linux-amd64":        released,
				"nexops-agent-linux-amd64.sha256": sidecarFor(released, "nexops-agent-linux-amd64"),
			}}
			out := New(Options{Fetcher: fetcher, Arch: "amd64", Version: "1.2.3", ExecPath: exe}).
				Run(context.Background())

			if out.Err == nil {
				t.Fatal("a binary that fails its version probe must abort the update")
			}
			if out.RestartPath != "" {
				t.Fatalf("restart path = %q, want none", out.RestartPath)
			}
			if !strings.Contains(out.Message, "`version` probe") {
				t.Fatalf("message does not explain the refusal: %q", out.Message)
			}
			if !strings.Contains(out.Message, ".nexops-agent-") {
				t.Fatalf("message must name the probed file: %q", out.Message)
			}
			onDisk, err := os.ReadFile(exe)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(onDisk, original) {
				t.Fatal("the installed binary must be untouched after a probe failure")
			}
			if _, err := os.Stat(exe + ".prev"); !os.IsNotExist(err) {
				t.Fatalf(".prev must not be created before a successful probe (stat err = %v)", err)
			}
			entries, err := os.ReadDir(dir)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 1 {
				t.Fatalf("temporary files left behind: %v", entries)
			}
		})
	}
}

// TestUpdaterReplacesStalePreviousBackup: a second update replaces the backup
// instead of accumulating one .prev file per release.
func TestUpdaterReplacesStalePreviousBackup(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "nexops-agent")
	first := fakeAgentScript("1.0.0")
	if err := os.WriteFile(exe, first, 0o755); err != nil {
		t.Fatal(err)
	}

	second := fakeAgentScript("2.0.0")
	third := fakeAgentScript("3.0.0")
	fetcher := &fakeFetcher{files: map[string][]byte{
		"nexops-agent-linux-amd64":        second,
		"nexops-agent-linux-amd64.sha256": sidecarFor(second, "nexops-agent-linux-amd64"),
	}}
	updater := New(Options{Fetcher: fetcher, Arch: "amd64", Version: "1.0.0", ExecPath: exe})
	if out := updater.Run(context.Background()); out.Err != nil {
		t.Fatalf("first update: %v", out.Err)
	}
	previous, err := os.ReadFile(exe + ".prev")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(previous, first) {
		t.Fatal("the first update must back up the original binary")
	}

	fetcher.files["nexops-agent-linux-amd64"] = third
	fetcher.files["nexops-agent-linux-amd64.sha256"] = sidecarFor(third, "nexops-agent-linux-amd64")
	if out := updater.Run(context.Background()); out.Err != nil {
		t.Fatalf("second update: %v", out.Err)
	}
	previous, err = os.ReadFile(exe + ".prev")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(previous, second) {
		t.Fatal("the second update must replace .prev with the previously installed build")
	}
	onDisk, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(onDisk, third) {
		t.Fatal("the second update was not installed")
	}
	if _, err := os.Stat(exe + ".prev.tmp"); !os.IsNotExist(err) {
		t.Fatalf("temporary backup link left behind (stat err = %v)", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("stale backups accumulated: %v", entries)
	}
}

// TestProbeVersion: the reusable probe reports execution success separately
// from whether the output could be parsed.
func TestProbeVersion(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good")
	if err := os.WriteFile(good, fakeAgentScript("4.5.6"), 0o755); err != nil {
		t.Fatal(err)
	}
	if version, ok := probeVersion(context.Background(), good); !ok || version != "4.5.6" {
		t.Fatalf("probe = (%q, %v), want (\"4.5.6\", true)", version, ok)
	}

	bad := filepath.Join(dir, "bad")
	if err := os.WriteFile(bad, []byte("#!/bin/sh\nexit 3\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if version, ok := probeVersion(context.Background(), bad); ok || version != unknownVersion {
		t.Fatalf("probe = (%q, %v), want (%q, false)", version, ok, unknownVersion)
	}

	unparseable := filepath.Join(dir, "unparseable")
	if err := os.WriteFile(unparseable, []byte("#!/bin/sh\necho hello\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if version, ok := probeVersion(context.Background(), unparseable); !ok || version != unknownVersion {
		t.Fatalf("probe = (%q, %v), want (%q, true)", version, ok, unknownVersion)
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
	wantMessage := fmt.Sprintf("installed 3.1.4 (old 3.0.0), restarting agent; previous build saved as %s.prev", exe)
	if out.Message != wantMessage {
		t.Fatalf("message = %q, want %q", out.Message, wantMessage)
	}
	if out.RestartPath != exe {
		t.Fatalf("restart path = %q, want %q", out.RestartPath, exe)
	}
}

// TestStageReadOnlyDirectoryLeavesOldBinaryIntact: staging fails on a
// read-only filesystem and the old binary survives.
func TestStageReadOnlyDirectoryLeavesOldBinaryIntact(t *testing.T) {
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

	if _, err := Stage(target, []byte("new binary"), 0o755); err == nil {
		t.Fatal("staging into a read-only directory must fail")
	}
	onDisk, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(onDisk, old) {
		t.Fatal("the old binary must be untouched")
	}
}

// TestCommitRenameFailureLeavesTargetIntact: a failed swap leaves the target
// untouched and never invalidates the rollback copy.
func TestCommitRenameFailureLeavesTargetIntact(t *testing.T) {
	t.Run("staged file disappears", func(t *testing.T) {
		dir := t.TempDir()
		target := filepath.Join(dir, "nexops-agent")
		old := []byte("old binary")
		if err := os.WriteFile(target, old, 0o755); err != nil {
			t.Fatal(err)
		}
		tmp, err := Stage(target, []byte("new binary"), 0o755)
		if err != nil {
			t.Fatalf("stage: %v", err)
		}
		// Removing the staged file after the backup has been refreshed forces
		// the final rename to fail while the target is still a regular file.
		if err := os.Remove(tmp); err != nil {
			t.Fatalf("remove staged file: %v", err)
		}
		if err := Commit(tmp, target); err == nil {
			t.Fatal("a missing staged file must fail the swap")
		}
		onDisk, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(onDisk, old) {
			t.Fatal("the target must be untouched after a failed rename")
		}
		// The refreshed .prev is byte-identical to the still-installed binary;
		// that is the correct rollback target for this failed update.
		previous, err := os.ReadFile(target + ".prev")
		if err != nil {
			t.Fatalf("the rollback copy must survive a failed rename: %v", err)
		}
		if !bytes.Equal(previous, old) {
			t.Fatal(".prev must be byte-identical to the still-installed binary")
		}
		if _, err := os.Stat(target + ".prev.tmp"); !os.IsNotExist(err) {
			t.Fatalf("temporary backup link left behind (stat err = %v)", err)
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 2 {
			t.Fatalf("unexpected files left behind: %v", entries)
		}
	})

	t.Run("target is a directory", func(t *testing.T) {
		dir := t.TempDir()
		target := filepath.Join(dir, "nexops-agent")
		if err := os.Mkdir(target, 0o755); err != nil {
			t.Fatal(err)
		}

		tmp, err := Stage(target, []byte("new binary"), 0o755)
		if err != nil {
			t.Fatalf("stage: %v", err)
		}
		if err := Commit(tmp, target); err == nil {
			t.Fatal("replacing a directory must fail")
		}
		if err := os.Remove(tmp); err != nil {
			t.Fatalf("remove staged file: %v", err)
		}
		info, err := os.Stat(target)
		if err != nil || !info.IsDir() {
			t.Fatal("the existing entry must be untouched")
		}
		if _, err := os.Stat(target + ".prev"); !os.IsNotExist(err) {
			t.Fatalf(".prev must not appear when the target cannot be linked (stat err = %v)", err)
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 1 {
			t.Fatalf("temporary files left behind: %v", entries)
		}
	})
}

// TestStageMissingDirectoryFails: the temporary file cannot even be created,
// so nothing is written anywhere.
func TestStageMissingDirectoryFails(t *testing.T) {
	target := filepath.Join(t.TempDir(), "missing", "nexops-agent")
	if _, err := Stage(target, []byte("new binary"), 0o755); err == nil {
		t.Fatal("staging into a missing directory must fail")
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("nothing must have been created")
	}
}
