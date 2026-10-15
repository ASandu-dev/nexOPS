import { respond } from "@/lib/server/errors";
import { clientIp, enforceRateLimit, RATE_RULES } from "@/lib/server/rate-limit";
import { loadReleaseFile } from "@/lib/server/releases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ file: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return respond(async () => {
    enforceRateLimit(`releases:${clientIp(request.headers)}`, RATE_RULES.releases);
    const { file } = await context.params;
    const release = await loadReleaseFile(file);

    return new Response(new Uint8Array(release.bytes), {
      headers: {
        "Content-Type": release.contentType,
        "Content-Length": String(release.bytes.byteLength),
        "Content-Disposition": `attachment; filename="${release.filename}"`,
        "Cache-Control": "public, max-age=300",
      },
    });
  });
}
