import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { OsFamily } from "@/lib/types";
import { notFound } from "./errors";

/** Whitelisted release artefacts — never touch the filesystem without this check. */
const RELEASE_FILES = new Set([
  "nexops-agent-linux-amd64",
  "nexops-agent-linux-arm64",
  "nexops-agent-linux-amd64.sha256",
  "nexops-agent-linux-arm64.sha256",
]);

/**
 * Public base URL of the control plane: env-configured first, request origin
 * as fallback (dev servers without NEXT_PUBLIC_APP_URL).
 * In Docker, compose derives NEXT_PUBLIC_APP_URL from APP_PORT/PUBLIC_ORIGIN.
 */
export function resolveBaseUrl(request: Request): string {
  const fromEnv = process.env["NEXT_PUBLIC_APP_URL"];
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim().replace(/\/+$/, "");
  return new URL(request.url).origin;
}

const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * One-line operator command from ARCHITECTURE.md §1: fetch script + checksum,
 * verify, then run with the enrolment token. `$BASE` is bound to the resolved
 * control-plane URL so every download and the agent itself use the same origin.
 */
export function buildInstallCommand(baseUrl: string, enrolmentToken: string, os: OsFamily): string {
  const base = shellSingleQuote(baseUrl);
  const token = shellSingleQuote(enrolmentToken);
  return (
    `BASE=${base} && ` +
    `curl -fsSLO "$BASE/api/agent/releases/install.sh" && ` +
    `curl -fsSLO "$BASE/api/agent/releases/install.sh.sha256" && ` +
    `sha256sum -c install.sh.sha256 && ` +
    `sudo ENROL_TOKEN=${token} CONTROL_PLANE_URL="$BASE" OS=${os.toLowerCase()} bash install.sh; ` +
    `rm -f install.sh install.sh.sha256`
  );
}

export interface ReleaseFile {
  bytes: Buffer;
  contentType: string;
  filename: string;
}

/** Loads a whitelisted agent binary (or its checksum) from AGENT_DIST_DIR. */
export async function loadReleaseFile(file: string): Promise<ReleaseFile> {
  if (!RELEASE_FILES.has(file)) {
    throw notFound(`Unknown release file '${file}'`);
  }
  const dir = path.resolve(process.cwd(), process.env["AGENT_DIST_DIR"] ?? "agent-dist");
  const filePath = path.join(dir, file);
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    const bytes = await readFile(filePath);
    return {
      bytes,
      contentType: file.endsWith(".sha256")
        ? "text/plain; charset=utf-8"
        : "application/octet-stream",
      filename: file,
    };
  } catch {
    throw notFound(
      `Agent binary '${file}' is not available. Build the agent for linux/amd64 and linux/arm64 into AGENT_DIST_DIR (default ./agent-dist), then retry.`,
    );
  }
}
