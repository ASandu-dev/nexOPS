//go:build !unix

package agent

import "errors"

// execRestart is unsupported outside unix. The agent only ships for Linux;
// other platforms keep running the already-installed binary.
func execRestart(path string) error {
	return errors.New("restarting the agent is not supported on this platform")
}
