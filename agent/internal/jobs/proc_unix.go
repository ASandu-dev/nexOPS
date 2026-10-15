//go:build unix

package jobs

import (
	"os"
	"os/exec"
	"syscall"
)

// setupProcGroup puts the command in its own process group so a timeout kill
// takes the whole tree down (apt spawns dpkg, systemctl spawns helpers, …).
func setupProcGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcGroup kills every process in the command's group. Negative pid
// targets the group led by pid.
func killProcGroup(p *os.Process) error {
	if p == nil {
		return nil
	}
	if err := syscall.Kill(-p.Pid, syscall.SIGKILL); err != nil {
		// Fall back to killing just the leader (group may already be gone).
		return p.Kill()
	}
	return nil
}
