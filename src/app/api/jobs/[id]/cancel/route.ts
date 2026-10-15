import { requireUser } from "@/lib/server/clerk";
import { toJobDto } from "@/lib/server/dto";
import { json, respond } from "@/lib/server/errors";
import { cancelJob } from "@/lib/server/jobs";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const userId = await requireUser();
    const { id } = await context.params;
    const job = await cancelJob(id, userId);
    return json(toJobDto(job));
  });
}
