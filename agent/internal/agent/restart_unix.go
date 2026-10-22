//go:build unix

package agent

import (
	"os"
	"syscall"
)

// execRestart replaces the current process image with path. The PID is
// preserved, so systemd keeps tracking the service and a container
// supervisor sees a plain restart instead of a crash loop.
func execRestart(path string) error {
	return syscall.Exec(path, os.Args, os.Environ())
}
