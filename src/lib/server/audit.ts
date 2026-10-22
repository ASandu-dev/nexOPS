import type { ActorType, Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export interface AuditInput {
  actorId: string;
  actorType: ActorType;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Appends an audit event. Failures are logged but never propagated: an audit
 * write must not roll back or fail the mutation it describes.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await writeAudit(prisma, input);
  } catch (error) {
    console.error("[audit] failed to record event", input.action, error);
  }
}

/**
 * Appends an audit event through the given client (the pooled client or a
 * transaction client). Unlike `recordAudit`, failures propagate: inside a
 * transaction a failed statement aborts it, so the caller decides whether the
 * event belongs to the atomic unit it describes.
 */
export async function writeAudit(
  store: Prisma.TransactionClient,
  input: AuditInput,
): Promise<void> {
  // exactOptionalPropertyTypes: omit rather than pass explicit undefined.
  const data: Prisma.AuditEventUncheckedCreateInput = {
    actorId: input.actorId,
    actorType: input.actorType,
    action: input.action,
  };
  if (input.targetType !== undefined) data.targetType = input.targetType;
  if (input.targetId !== undefined) data.targetId = input.targetId;
  if (input.metadata !== undefined) data.metadata = input.metadata;
  await store.auditEvent.create({ data });
}
