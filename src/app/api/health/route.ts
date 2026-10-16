import { NextResponse } from "next/server";

// Deliberately free of Clerk/Prisma imports: must answer even when the DB or
// auth config is unavailable, so infra can use it as a liveness probe.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json({ status: "ok", uptimeSec: process.uptime() });
}
