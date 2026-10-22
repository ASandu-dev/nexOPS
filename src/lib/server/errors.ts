import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { ZodError } from "zod";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "BAD_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL_ERROR"
  // Job-specific conflict codes. Lower-case because they are part of the
  // published endpoint contract (the dashboard branches on them).
  | "job_not_retryable"
  | "job_already_active";

export interface FieldIssue {
  path: string;
  message: string;
}

/**
 * Typed operational error. Anything that escapes a route handler without being
 * an ApiError is treated as an internal failure and never leaks its message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly issues: readonly FieldIssue[] | undefined;
  readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    options?: {
      issues?: readonly FieldIssue[];
      headers?: Readonly<Record<string, string>>;
    },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = options?.issues;
    this.headers = options?.headers;
  }
}

export const unauthorized = (message = "Authentication required"): ApiError =>
  new ApiError(401, "UNAUTHORIZED", message);

export const notFound = (message = "Resource not found"): ApiError =>
  new ApiError(404, "NOT_FOUND", message);

export const conflict = (message: string): ApiError =>
  new ApiError(409, "CONFLICT", message);

/** 409: the job is not in a state that can be retried. */
export const jobNotRetryable = (message: string): ApiError =>
  new ApiError(409, "job_not_retryable", message);

/** 409: another job of the same type is already active for the target. */
export const jobAlreadyActive = (message: string): ApiError =>
  new ApiError(409, "job_already_active", message);

const zodIssues = (error: ZodError): FieldIssue[] =>
  error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));

/** Parse untrusted JSON body data, converting Zod failures into a 400. */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "Request body validation failed", {
      issues: zodIssues(result.error),
    });
  }
  return result.data;
}

/** Parse URL search params (as a record of strings) against a schema. */
export function parseQuery<T>(
  schema: ZodType<T>,
  params: URLSearchParams,
): T {
  const record = Object.fromEntries(params.entries());
  const result = schema.safeParse(record);
  if (!result.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "Query parameter validation failed", {
      issues: zodIssues(result.error),
    });
  }
  return result.data;
}

/** Upper bound on accepted request bodies (bytes), enforced pre-parse (CWE-770). */
const MAX_BODY_BYTES = 1_048_576;

/** Read and decode a JSON request body; malformed JSON is a 400. */
export async function readJson(request: Request): Promise<unknown> {
  // Reject oversized bodies before buffering them. Content-Length can be
  // absent (chunked transfer encoding), in which case parsing proceeds — an
  // accepted residual risk covered by the reverse proxy's own body limits.
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body too large");
  }
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "BAD_REQUEST", "Request body is not valid JSON");
  }
}

/** Convert any thrown value into a consistent `{error:{code,message}}` response. */
export function errorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    const errorObj: Record<string, unknown> = {
      code: error.code,
      message: error.message,
    };
    if (error.issues && error.issues.length > 0) {
      errorObj["details"] = error.issues;
    }
    const init: ResponseInit = { status: error.status };
    if (error.headers) init.headers = error.headers;
    return NextResponse.json({ error: errorObj }, init);
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: zodIssues(error),
        },
      },
      { status: 400 },
    );
  }
  // Never expose stack traces or internal messages.
  console.error("[api] unhandled error", error);
  return NextResponse.json(
    { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
    { status: 500 },
  );
}

/**
 * Wraps a route handler so every thrown error becomes a JSON error response.
 * Routes stay declarative: they throw ApiError instead of building responses.
 */
export async function respond(
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    return errorResponse(error);
  }
}

export function json<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}
