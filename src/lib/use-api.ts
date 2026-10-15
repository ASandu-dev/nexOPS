"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Minimal typed fetch layer for the control-plane API.
 *
 * The API always answers errors with `{ error: { code, message, details? } }`
 * (see src/lib/server/errors.ts), so every failure is normalised into an
 * `ApiError` the UI can render without guessing at the shape.
 */

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isApiErrorBody(value: unknown): value is { error: ApiErrorBody } {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) return new ApiError(0, "NETWORK_ERROR", error.message);
  return new ApiError(0, "UNKNOWN_ERROR", "Unexpected error");
}

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  /** Serialised as JSON when present. */
  body?: unknown;
}

/** Fetch JSON from the API, throwing a typed `ApiError` on any non-2xx response. */
export async function apiFetch<T>(input: string, options: ApiFetchOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;
  const mergedHeaders = new Headers(headers);
  if (body !== undefined && !mergedHeaders.has("Content-Type")) {
    mergedHeaders.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(input, {
      ...rest,
      headers: mergedHeaders,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw toApiError(error);
  }

  if (!response.ok) {
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      // Non-JSON error body (proxy, gateway); fall back to the status text.
    }
    if (isApiErrorBody(parsed)) {
      throw new ApiError(response.status, parsed.error.code, parsed.error.message, parsed.error.details);
    }
    throw new ApiError(response.status, "HTTP_ERROR", `Request failed with status ${response.status}`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface UseApiResult<T> {
  data: T | null;
  error: ApiError | null;
  /** True only while the first load is in flight; background refreshes keep the last data. */
  loading: boolean;
  /** True while any request (initial or refresh) is in flight. */
  fetching: boolean;
  refresh: () => void;
}

export interface UseApiOptions {
  /** Poll interval in milliseconds. Omit to disable polling. */
  refreshIntervalMs?: number;
}

/**
 * Declarative GET hook with abort-on-unmount, manual `refresh`, and optional
 * polling. `url === null` disables the request entirely (useful for dependent
 * fetches such as a selected target id).
 */
export function useApi<T>(url: string | null, options: UseApiOptions = {}): UseApiResult<T> {
  const { refreshIntervalMs } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [fetching, setFetching] = useState<boolean>(url !== null);
  const [nonce, setNonce] = useState(0);
  const hasDataRef = useRef(false);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (url === null) {
      hasDataRef.current = false;
      setData(null);
      setError(null);
      setFetching(false);
      return;
    }

    const controller = new AbortController();
    let active = true;
    setFetching(true);

    apiFetch<T>(url, { signal: controller.signal })
      .then((result) => {
        if (!active) return;
        hasDataRef.current = true;
        setData(result);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(toApiError(caught));
      })
      .finally(() => {
        if (active) setFetching(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [url, nonce]);

  useEffect(() => {
    if (refreshIntervalMs === undefined || url === null) return;
    const timer = window.setInterval(refresh, refreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [refreshIntervalMs, url, refresh]);

  return {
    data,
    error,
    loading: fetching && !hasDataRef.current,
    fetching,
    refresh,
  };
}

/** Debounce a rapidly changing value (search inputs) by `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
