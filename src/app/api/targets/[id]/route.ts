import { requireUser } from "@/lib/server/clerk";
import { json, parseBody, readJson, respond } from "@/lib/server/errors";
import { updateTargetSchema } from "@/lib/server/schemas";
import { deleteTarget, getTargetDetail, updateTarget, type UpdateTargetInput } from "@/lib/server/targets";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  return respond(async () => {
    await requireUser();
    const { id } = await context.params;
    return json(await getTargetDetail(id));
  });
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const userId = await requireUser();
    const { id } = await context.params;
    const body = parseBody(updateTargetSchema, await readJson(request));

    const patch: UpdateTargetInput = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.hostnameOverride !== undefined) patch.hostnameOverride = body.hostnameOverride;
    if (body.labels !== undefined) patch.labels = body.labels;

    return json(await updateTarget(id, patch, userId));
  });
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const userId = await requireUser();
    const { id } = await context.params;
    await deleteTarget(id, userId);
    return json({ id, deleted: true });
  });
}
