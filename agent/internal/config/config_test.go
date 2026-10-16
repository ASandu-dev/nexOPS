package config

import "testing"

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
