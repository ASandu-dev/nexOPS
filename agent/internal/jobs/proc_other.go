//go:build !unix

package jobs

import (
	"os"
	"os/exec"
)

// Non-unix fallback: no process groups; the default single-process kill
// applies. The agent only targets linux, this keeps `go vet ./...` green on
// any host.
func setupProcGroup(cmd *exec.Cmd) {}

func killProcGroup(p *os.Process) error {
	if p == nil {
		return nil
	}
	return p.Kill()
}
