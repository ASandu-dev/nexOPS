// Package apt routes apt maintenance operations through the audited,
// sudoers-whitelisted /usr/local/libexec/nexops-apt helper when it is
// installed (production hosts, where the agent runs unprivileged and apt
// needs root). Without the helper it falls back to a direct apt-get
// invocation, which is what dev environments and containers rely on.
package apt

import (
	"context"
	"fmt"
	"os"
	"os/exec"
)

// HelperPath is the privileged apt helper written by install.sh and
// whitelisted (NOPASSWD, exact path) in /etc/sudoers.d/nexops-agent.
const HelperPath = "/usr/local/libexec/nexops-apt"

// Sub is one of the four whitelisted helper subcommands. Job types are
// hard-mapped to these values; nothing else may reach argv.
type Sub string

const (
	Update    Sub = "update"
	Upgrade   Sub = "upgrade"
	FixBroken Sub = "fix-broken"
	Simulate  Sub = "simulate"
)

// Spec is an argv vector plus extra environment assignments — never a shell
// string, mirroring the job runner's cmdSpec.
type Spec struct {
	Name string
	Args []string
	Env  []string
}

// SpecFor returns the command spec for sub. The helper is used when it is
// installed and executable, so apt runs as root with sudo -n (non-interactive:
// the service has no TTY, and a missing grant must fail fast instead of
// hanging on a password prompt).
func SpecFor(sub Sub) (Spec, error) {
	return specFor(sub, helperInstalled(HelperPath))
}

// AptCommand builds a ready-to-run command for sub under ctx.
func AptCommand(ctx context.Context, sub Sub) (*exec.Cmd, error) {
	s, err := SpecFor(sub)
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, s.Name, s.Args...)
	if len(s.Env) > 0 {
		cmd.Env = append(os.Environ(), s.Env...)
	}
	return cmd, nil
}

// Available reports whether apt maintenance can run at all: via the sudoers
// helper, or (fallback) a direct apt-get binary in PATH. A host with neither
// is skipped instead of failing a job or a heartbeat on every cycle.
func Available() bool {
	if helperInstalled(HelperPath) {
		return true
	}
	_, err := exec.LookPath("apt-get")
	return err == nil
}

// specFor takes the helper-availability decision as a parameter so both
// branches are unit-testable without the helper existing on the test host.
// A non-whitelisted sub is rejected before it can reach argv on either path.
func specFor(sub Sub, helperAvailable bool) (Spec, error) {
	if sub != Update && sub != Upgrade && sub != FixBroken && sub != Simulate {
		return Spec{}, fmt.Errorf("apt: %q is not a whitelisted subcommand", sub)
	}
	if helperAvailable {
		// The helper re-applies DEBIAN_FRONTEND=noninteractive for upgrade
		// itself, so the elevated path needs no extra environment beyond the
		// locale pinning below.
		s := Spec{Name: "sudo", Args: []string{"-n", HelperPath, string(sub)}}
		if sub == Simulate {
			// The control plane parses apt's "Inst " lines; pin the locale on
			// both paths because sudo's env_reset may strip LANG before the
			// helper sees it.
			s.Env = []string{"LANG=C", "LC_ALL=C"}
		}
		return s, nil
	}
	switch sub {
	case Update:
		return Spec{Name: "apt-get", Args: []string{"update", "-y"}}, nil
	case Upgrade:
		// Non-interactive so apt never blocks on conffile prompts.
		return Spec{Name: "apt-get", Args: []string{"upgrade", "-y"}, Env: []string{"DEBIAN_FRONTEND=noninteractive"}}, nil
	case FixBroken:
		// Recovery path for a half-configured dpkg state; non-interactive for
		// the same reason as upgrade.
		return Spec{Name: "apt-get", Args: []string{"-f", "install", "-y"}, Env: []string{"DEBIAN_FRONTEND=noninteractive"}}, nil
	default: // Simulate
		return Spec{Name: "apt-get", Args: []string{"-s", "upgrade"}, Env: []string{"LANG=C", "LC_ALL=C"}}, nil
	}
}

// helperInstalled is the production availability check; kept separate from
// specFor so tests can exercise it against arbitrary paths.
func helperInstalled(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.Mode().IsRegular() && st.Mode().Perm()&0o111 != 0
}
