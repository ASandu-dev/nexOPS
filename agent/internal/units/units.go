// Package units validates systemd unit names before they are passed to
// systemctl on the command line. Only this restricted charset is allowed so a
// malicious or corrupted job param can never be interpreted as extra flags or
// shell syntax.
package units

import "regexp"

// unitNameRe mirrors the systemd unit naming rules for the subset NexOPS
// watches: service names, template instances (getty@tty1), and timer/socket
// style suffixes.
var unitNameRe = regexp.MustCompile(`^[a-zA-Z0-9@._-]+$`)

// ValidName reports whether name is safe to pass as a single argv element to
// systemctl. Rejects empty strings, anything with shell metacharacters,
// whitespace, slashes, and leading dashes (which systemctl would read as
// flags rather than a unit name).
func ValidName(name string) bool {
	if name == "" || len(name) > 256 || name[0] == '-' {
		return false
	}
	return unitNameRe.MatchString(name)
}
