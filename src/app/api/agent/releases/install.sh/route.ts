import { respond } from "@/lib/server/errors";
import { generateInstallScript } from "@/lib/server/install-script";
import { clientIp, enforceRateLimit, RATE_RULES } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return respond(async () => {
    enforceRateLimit(`releases:${clientIp(request.headers)}`, RATE_RULES.releases);
    return new Response(generateInstallScript(), {
      headers: {
        "Content-Type": "text/x-shellscript; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  });
}
