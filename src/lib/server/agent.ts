import type { AgentIdentity, Job, Target } from "@prisma/client";
import type { AgentEnrolResponse, HeartbeatResponse } from "@/lib/types";
import { prisma } from "./prisma";
import { recordAudit, type AuditInput } from "./audit";
import { randomToken, safeEqual, sha256, verifyEd25519 } from "./crypto";
import { capTail, dispatchQueuedJobs, isTerminal } from "./jobs";
import { getSettings } from "./settings";
import { notFound, unauthorized } from "./errors";
import type { enrolSchema, jobResultSchema } from "./schemas";
import { toJobDto } from "./dto";
import type { z } from "zod";

export type EnrolInput = z.infer<typeof enrolSchema>;
export type JobResultInput = z.infer<typeof jobResultSchema>;

export interface AuthenticatedAgent {
  identity: AgentIdentity;
  target: Target;
}

/**
 * Resolves `Authorization: Bearer <credential>` to an enrolled, non-revoked
 * agent identity. The credential is never stored — only its SHA-256 hash,
 * matched against the unique `credentialHash` and re-checked in constant time.
 */
export async function requireAgent(request: Request): Promise<AuthenticatedAgent> {
  const header = request.headers.get("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    throw unauthorized("Invalid credential");
  }
  const credential = header.slice(7).trim();
  if (!credential) throw unauthorized("Invalid credential");

  const hash = sha256(credential);
  const identity = await prisma.agentIdentity.findUnique({
    where: { credentialHash: hash },
    include: { target: true },
  });
  if (
    !identity ||
    identity.credentialHash === null ||
    identity.revokedAt !== null ||
    identity.target.deletedAt !== null
  ) {
    throw unauthorized("Invalid credential");
  }
  if (!safeEqual(hash, identity.credentialHash)) {
    throw unauthorized("Invalid credential");
  }
  return { identity, target: identity.target };
}

/**
 * Token lookup → Ed25519 signature verification → single-use consumption and
 * credential issuance in one transaction. Every rejection is audited and
 * answers with the same generic 401 message.
 */
export async function enrolAgent(input: EnrolInput): Promise<AgentEnrolResponse> {
  const now = new Date();
  const tokenHash = sha256(input.token);
  const token = await prisma.enrolmentToken.findUnique({
    where: { tokenHash },
    include: { target: true },
  });

  const tokenUsable =
    token !== null && token.usedAt === null && token.expiresAt > now && token.target.deletedAt === null;
  if (!tokenUsable) {
    const failure: AuditInput = {
      actorId: token?.targetId ?? "anonymous",
      actorType: "AGENT",
      action: "enrol.attempt_failed",
      metadata: {
        reason: token === null ? "token_unknown" : token.usedAt !== null ? "token_used" : "token_expired",
      },
    };
    if (token) {
      failure.targetType = "target";
      failure.targetId = token.targetId;
    }
    await recordAudit(failure);
    throw unauthorized("Invalid enrolment token");
  }

  const signatureValid = verifyEd25519(
    input.publicKey,
    Buffer.from(input.token, "utf8"),
    input.signature,
  );
  if (!signatureValid) {
    await recordAudit({
      actorId: token.targetId,
      actorType: "AGENT",
      action: "enrol.attempt_failed",
      targetType: "target",
      targetId: token.targetId,
      metadata: { reason: "signature_invalid" },
    });
    throw unauthorized("Invalid enrolment signature");
  }

  const credential = randomToken();
  const credentialHash = sha256(credential);

  const identity = await prisma.$transaction(async (tx) => {
    // Single-use guard: only the request that flips usedAt from null wins the
    // race (CWE-362). A losing concurrent enrol rolls the transaction back.
    const consumed = await tx.enrolmentToken.updateMany({
      where: { id: token.id, usedAt: null },
      data: { usedAt: now },
    });
    if (consumed.count === 0) {
      throw unauthorized("Invalid enrolment token");
    }

    const existing = await tx.agentIdentity.findUnique({ where: { targetId: token.targetId } });
    const identity = existing
      ? await tx.agentIdentity.update({
          where: { targetId: token.targetId },
          data: {
            publicKey: input.publicKey,
            credentialHash,
            credentialIssuedAt: now,
            agentVersion: input.agentVersion,
            enrolledAt: now,
            revokedAt: null,
          },
        })
      : await tx.agentIdentity.create({
          data: {
            targetId: token.targetId,
            publicKey: input.publicKey,
            credentialHash,
            credentialIssuedAt: now,
            agentVersion: input.agentVersion,
            enrolledAt: now,
          },
        });

    // Status stays PENDING_ENROLMENT until the first valid heartbeat.
    await tx.target.update({
      where: { id: token.targetId },
      data: {
        hostname: input.hostname,
        os: input.os,
        osVersion: input.osVersion,
        arch: input.arch,
      },
    });
    return identity;
  });

  await recordAudit({
    actorId: identity.id,
    actorType: "AGENT",
    action: "target.enrol",
    targetType: "target",
    targetId: token.targetId,
    metadata: {
      hostname: input.hostname,
      os: input.os,
      arch: input.arch,
      agentVersion: input.agentVersion,
    },
  });

  const { settings } = await getSettings();
  return {
    agentId: identity.id,
    targetId: token.targetId,
    credential,
    heartbeatIntervalSec: settings.heartbeatIntervalSec,
  };
}

/**
 * Records a job result. Idempotent: a result replayed for an already-terminal
 * job returns the stored job unchanged (ARCHITECTURE.md §3).
 */
export async function submitJobResult(
  identity: AgentIdentity,
  jobId: string,
  input: JobResultInput,
): Promise<Job> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  // Non-existent and foreign jobs answer identically to avoid probing.
  if (!job || job.targetId !== identity.targetId) throw notFound("Job not found");
  if (isTerminal(job.status)) return job;

  const updated = await prisma.job.updateMany({
    where: { id: jobId, status: { in: ["QUEUED", "DISPATCHED", "RUNNING"] } },
    data: {
      status: input.status,
      exitCode: input.exitCode,
      stdoutTail: capTail(input.stdoutTail),
      stderrTail: capTail(input.stderrTail),
      startedAt: input.startedAt ? new Date(input.startedAt) : job.startedAt,
      finishedAt: input.finishedAt ? new Date(input.finishedAt) : new Date(),
    },
  });

  const result = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  if (updated.count === 0) {
    // Lost a race against a concurrent terminal write — keep the first result.
    return result;
  }

  await recordAudit({
    actorId: identity.id,
    actorType: "AGENT",
    action: "job.result",
    targetType: "job",
    targetId: identity.targetId,
    metadata: { jobId, status: result.status, exitCode: result.exitCode, jobType: result.type },
  });
  return result;
}

/** Queued jobs handed to the agent on this poll, already moved to DISPATCHED. */
export async function collectDispatchedJobs(
  targetId: string,
  activeJobIds?: string[],
): Promise<HeartbeatResponse> {
  const jobs = await dispatchQueuedJobs(targetId);
  let cancelledJobIds: string[] | undefined;
  if (activeJobIds && activeJobIds.length > 0) {
    const cancelled = await prisma.job.findMany({
      where: {
        id: { in: activeJobIds },
        targetId,
        status: "CANCELLED",
      },
      select: { id: true },
    });
    if (cancelled.length > 0) {
      cancelledJobIds = cancelled.map((c) => c.id);
    }
  }
  return {
    jobs: jobs.map((job) => toJobDto(job)),
    ...(cancelledJobIds ? { cancelledJobIds } : {}),
  };
}
