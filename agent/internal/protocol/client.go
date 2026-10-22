package protocol

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// maxResponseBody bounds how much of an error/body payload is retained for
// diagnostics (Next.js error pages can be large HTML).
const maxResponseBody = 2 << 20 // 2 MiB

// maxReleaseBytes bounds a downloaded release artefact. The agent binary is a
// few megabytes; the cap keeps a broken or hostile server from exhausting the
// agent's memory.
const maxReleaseBytes = 64 << 20 // 64 MiB

// errorSnippetLen is how much of a non-2xx body is kept in APIError.
const errorSnippetLen = 2048

// APIError is returned for any non-2xx response. It never contains request
// bodies or credentials, so it is safe to log.
type APIError struct {
	StatusCode int
	Body       string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("control plane returned HTTP %d: %s", e.StatusCode, e.Body)
}

// Retryable reports whether the failure is worth retrying with backoff.
// 5xx and 429 are transient; other 4xx indicate a request problem (bad
// credential, consumed token) but the agent still retries slowly because a
// revoked credential can be re-provisioned server-side while we run.
func (e *APIError) Retryable() bool {
	return e.StatusCode >= 500 || e.StatusCode == http.StatusTooManyRequests
}

// IsAuthError reports whether err is a 401/403 from the control plane, i.e.
// the bearer credential was rejected or revoked. The caller must not retry
// with the same credential: it has to clear the stored identity and re-enrol.
func IsAuthError(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) &&
		(apiErr.StatusCode == http.StatusUnauthorized || apiErr.StatusCode == http.StatusForbidden)
}

// Client talks to the control plane over TLS. Plain http:// is accepted only
// when the operator configured it explicitly (local dev); TLS verification is
// never disabled.
type Client struct {
	baseURL string
	http    *http.Client
}

// NewClient validates baseURL and returns a client with a 30s request timeout.
func NewClient(baseURL string) (*Client, error) {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return nil, fmt.Errorf("invalid CONTROL_PLANE_URL: %w", err)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return nil, fmt.Errorf("invalid CONTROL_PLANE_URL %q: scheme must be https (or http for local dev)", baseURL)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("invalid CONTROL_PLANE_URL %q: missing host", baseURL)
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Timeout: 30 * time.Second},
	}, nil
}

// Enrol exchanges the single-use enrol token for a long-lived credential.
// No bearer credential is attached (none exists yet).
func (c *Client) Enrol(ctx context.Context, req EnrolRequest) (EnrolResponse, error) {
	var resp EnrolResponse
	if err := c.post(ctx, PathEnrol, "", req, &resp); err != nil {
		return EnrolResponse{}, err
	}
	return resp, nil
}

// Heartbeat submits telemetry and receives dispatched jobs. An empty job list
// decodes to a non-nil slice so callers can range safely.
func (c *Client) Heartbeat(ctx context.Context, credential string, req HeartbeatRequest) (HeartbeatResponse, error) {
	var resp HeartbeatResponse
	if err := c.post(ctx, PathHearbeat, credential, req, &resp); err != nil {
		return HeartbeatResponse{}, err
	}
	if resp.Jobs == nil {
		resp.Jobs = []Job{}
	}
	if resp.CancelledJobIds == nil {
		resp.CancelledJobIds = []string{}
	}
	return resp, nil
}

// JobResult reports a finished job. The server treats replays as no-ops.
func (c *Client) JobResult(ctx context.Context, credential, jobID string, result JobResultRequest) error {
	return c.post(ctx, JobResultPath(jobID), credential, result, nil)
}

// Release downloads a published artefact (agent binary or checksum sidecar)
// from the control plane's release endpoint.
//
// The URL is always derived from the configured base URL and the caller only
// supplies a bare file name, so the agent can never be pointed at another
// host: the release origin is the same one install.sh trusts.
func (c *Client) Release(ctx context.Context, file string) ([]byte, error) {
	apiPath, err := ReleasePath(file)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+apiPath, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/octet-stream")
	req.Header.Set("User-Agent", "nexops-agent")

	httpResp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("get %s: %w", apiPath, err)
	}
	defer httpResp.Body.Close()

	if httpResp.StatusCode < 200 || httpResp.StatusCode > 299 {
		raw, _ := io.ReadAll(io.LimitReader(httpResp.Body, maxResponseBody))
		return nil, &APIError{StatusCode: httpResp.StatusCode, Body: snippet(raw)}
	}
	body, err := io.ReadAll(io.LimitReader(httpResp.Body, maxReleaseBytes))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", apiPath, err)
	}
	return body, nil
}

func (c *Client) post(ctx context.Context, apiPath, bearer string, in, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return fmt.Errorf("encode request: %w", err)
	}
	url := c.baseURL + apiPath
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "nexops-agent")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}

	httpResp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("post %s: %w", apiPath, err)
	}
	defer httpResp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(httpResp.Body, maxResponseBody))
	if err != nil {
		return fmt.Errorf("read response from %s: %w", apiPath, err)
	}
	if httpResp.StatusCode < 200 || httpResp.StatusCode > 299 {
		return &APIError{StatusCode: httpResp.StatusCode, Body: snippet(raw)}
	}
	if out != nil && len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("decode response from %s: %w", apiPath, err)
		}
	}
	return nil
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > errorSnippetLen {
		s = s[:errorSnippetLen] + "…"
	}
	if s == "" {
		s = "(empty body)"
	}
	return s
}
