import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/server/clerk";
import { toAuditDto, toPaginated } from "@/lib/server/dto";
import { json, parseQuery, respond } from "@/lib/server/errors";
import { prisma } from "@/lib/server/prisma";
import { auditListQuerySchema } from "@/lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return respond(async () => {
    await requireUser();
    const query = parseQuery(auditListQuerySchema, new URL(request.url).searchParams);

    const where: Prisma.AuditEventWhereInput = {};
    if (query.action) where.action = query.action;
    if (query.actorType) where.actorType = query.actorType;
    if (query.targetId) where.targetId = query.targetId;

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const total = await prisma.auditEvent.count({ where });
    const events =
      total === 0
        ? []
        : await prisma.auditEvent.findMany({
            where,
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * pageSize,
            take: pageSize,
          });

    return json(toPaginated(events.map(toAuditDto), page, pageSize, total));
  });
}
