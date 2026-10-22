import { requireUser } from "@/lib/server/clerk";
import { toJobDto } from "@/lib/server/dto";
import { json, respond } from "@/lib/server/errors";
import { retryJob } from "@/lib/server/jobs";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Re-queues a failed job as a new QUEUED job (history is never rewritten).
 *
 * Only FAILED and TIMED_OUT jobs can be retried (`job_not_retryable`), and
 * only when no job of the same type is still active for the target
 * (`job_already_active`).
 */
export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const userId = await requireUser();
    const { id } = await context.params;
    const job = await retryJob(id, userId);
    return json({ job: toJobDto(job) });
  });
}
