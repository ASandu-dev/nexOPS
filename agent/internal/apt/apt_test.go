package apt

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSpecForHelperPresent pins the elevated argv: sudo -n (never
// interactive), exact helper path, whitelisted subcommand as the single
// argument.
func TestSpecForHelperPresent(t *testing.T) {
	cases := []struct {
		sub     Sub
		wantEnv string
	}{
		{Update, ""},
		{Upgrade, ""},
		{FixBroken, ""},
		{Simulate, "LANG=C LC_ALL=C"},
	}
	for _, c := range cases {
		s, err := specFor(c.sub, true)
		if err != nil {
			t.Fatalf("%s: %v", c.sub, err)
		}
		if s.Name != "sudo" {
			t.Errorf("%s: name = %q, want sudo", c.sub, s.Name)
		}
		want := "-n " + HelperPath + " " + string(c.sub)
		if got := strings.Join(s.Args, " "); got != want {
			t.Errorf("%s: args = %q, want %q", c.sub, got, want)
		}
		if got := strings.Join(s.Env, " "); got != c.wantEnv {
			t.Errorf("%s: env = %q, want %q", c.sub, got, c.wantEnv)
		}
	}
}

// TestSpecForHelperAbsent pins the dev/containers fallback argv.
func TestSpecForHelperAbsent(t *testing.T) {
	cases := []struct {
		sub     Sub
		wantArg string
		wantEnv string
	}{
		{Update, "update -y", ""},
		{Upgrade, "upgrade -y", "DEBIAN_FRONTEND=noninteractive"},
		{FixBroken, "-f install -y", "DEBIAN_FRONTEND=noninteractive"},
		{Simulate, "-s upgrade", "LANG=C LC_ALL=C"},
	}
	for _, c := range cases {
		s, err := specFor(c.sub, false)
		if err != nil {
			t.Fatalf("%s: %v", c.sub, err)
		}
		if s.Name != "apt-get" {
			t.Errorf("%s: name = %q, want apt-get", c.sub, s.Name)
		}
		if got := strings.Join(s.Args, " "); got != c.wantArg {
			t.Errorf("%s: args = %q, want %q", c.sub, got, c.wantArg)
		}
		if got := strings.Join(s.Env, " "); got != c.wantEnv {
			t.Errorf("%s: env = %q, want %q", c.sub, got, c.wantEnv)
		}
	}
}

// TestSpecForRejectsUnknownSub: nothing outside the whitelist reaches argv,
// whether or not the helper is installed.
func TestSpecForRejectsUnknownSub(t *testing.T) {
	for _, sub := range []Sub{"rm", "update --force", "", "Update"} {
		for _, available := range []bool{true, false} {
			if _, err := specFor(sub, available); err == nil {
				t.Errorf("sub %q (helper=%v) must be rejected", sub, available)
			}
		}
	}
	if _, err := AptCommand(context.Background(), Sub("rm")); err == nil {
		t.Fatal("AptCommand must reject a non-whitelisted subcommand")
	}
}

// TestHelperInstalled exercises the real availability check against a
// controlled filesystem: present+executable only.
func TestHelperInstalled(t *testing.T) {
	dir := t.TempDir()

	if helperInstalled(filepath.Join(dir, "missing")) {
		t.Error("missing helper must be reported absent")
	}
	if helperInstalled(dir) {
		t.Error("a directory must not count as the helper")
	}

	secret := filepath.Join(dir, "secret")
	if err := os.WriteFile(secret, []byte("#!/bin/sh\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if helperInstalled(secret) {
		t.Error("helper without any execute bit must be reported absent")
	}

	plain := filepath.Join(dir, "plain")
	if err := os.WriteFile(plain, []byte("#!/bin/sh\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if helperInstalled(plain) {
		t.Error("world-readable but non-executable file must be reported absent")
	}

	installed := filepath.Join(dir, "nexops-apt")
	if err := os.WriteFile(installed, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !helperInstalled(installed) {
		t.Error("0755 regular file must be reported present")
	}
	// The production path is reached through symlinks (e.g. /usr/local layout
	// differences); os.Stat follows them, so a link to the helper counts.
	link := filepath.Join(dir, "link")
	if err := os.Symlink(installed, link); err != nil {
		t.Fatal(err)
	}
	if !helperInstalled(link) {
		t.Error("symlink to an executable helper must be reported present")
	}
}
