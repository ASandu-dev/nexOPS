package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestScrubEnrolToken: successful scrub drops the ENROL_TOKEN line, keeps
// every other line intact, and preserves the original file mode.
func TestScrubEnrolToken(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.env")
	content := "CONTROL_PLANE_URL=https://cp.example.com\nENROL_TOKEN=secret\nOS=UBUNTU\n"
	if err := os.WriteFile(path, []byte(content), 0o640); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.EnrolToken != "secret" {
		t.Fatalf("EnrolToken = %q, want %q", cfg.EnrolToken, "secret")
	}
	cfg.ScrubEnrolToken()

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := "CONTROL_PLANE_URL=https://cp.example.com\nOS=UBUNTU\n"
	if string(got) != want {
		t.Fatalf("after scrub = %q, want %q", got, want)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o640 {
		t.Fatalf("mode after scrub = %o, want 640", st.Mode().Perm())
	}
	if cfg.EnrolToken != "" {
		t.Fatalf("EnrolToken not cleared in memory: %q", cfg.EnrolToken)
	}
	// Idempotent: a second scrub is a no-op.
	cfg.ScrubEnrolToken()
}

// TestScrubEnrolTokenUnwritable: a permission-denied scrub must not panic and
// must leave the file untouched (best-effort, warns and returns without error).
func TestScrubEnrolTokenUnwritable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory write permissions")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.env")
	content := "CONTROL_PLANE_URL=https://cp.example.com\nENROL_TOKEN=secret\n"
	if err := os.WriteFile(path, []byte(content), 0o640); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	// Remove write on the directory so the temp-file+rename fails.
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })

	cfg.ScrubEnrolToken() // must not panic or return; logs WARNING

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "ENROL_TOKEN=secret") {
		t.Fatalf("file should be unchanged after failed scrub, got %q", got)
	}
}

// TestStateMatchesControlPlane covers the stale-identity reset decision: the
// env file's CONTROL_PLANE_URL is authoritative, so only a URL-normalised
// match may keep the stored credential.
func TestStateMatchesControlPlane(t *testing.T) {
	cases := []struct {
		name   string
		stored string
		config string
		want   bool
	}{
		{"exact", "https://cp.example.com", "https://cp.example.com", true},
		{"trailing slash in stored", "https://cp.example.com/", "https://cp.example.com", true},
		{"trailing slash in config", "https://cp.example.com", "https://cp.example.com/", true},
		{"trailing slashes both", "https://cp.example.com//", "https://cp.example.com/", true},
		{"surrounding whitespace", " https://cp.example.com ", "https://cp.example.com", true},
		{"different host", "https://old.example.com", "https://cp.example.com", false},
		{"different port", "http://localhost:3560", "http://localhost:3000", false},
		{"scheme differs", "http://cp.example.com", "https://cp.example.com", false},
		{"stored empty", "", "https://cp.example.com", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st := State{AgentID: "a1", Credential: "c1", ControlPlaneURL: tc.stored}
			if got := st.MatchesControlPlane(tc.config); got != tc.want {
				t.Fatalf("MatchesControlPlane(%q) with stored %q = %v, want %v",
					tc.config, tc.stored, got, tc.want)
			}
		})
	}
}
