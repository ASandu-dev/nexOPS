import { PrismaClient } from "@prisma/client";

/**
 * Singleton Prisma client. Next.js hot reload re-evaluates modules on every
 * edit, so the instance is parked on `globalThis` to avoid exhausting the
 * connection pool during development.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
