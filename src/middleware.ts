import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextMiddleware } from "next/server";

/*
 * The dashboard and control-plane API are Clerk-protected. The agent
 * endpoints must stay reachable without a browser session because enrolled
 * agents authenticate with their own bearer credential inside the handler,
 * and the health endpoint must answer even when Clerk keys are unset — so
 * they are explicitly treated as public here and return before the Clerk
 * handler is ever invoked.
 */
const isPublicRoute = createRouteMatcher([
  "/api/agent(.*)",
  "/api/agent/releases(.*)",
  "/api/health(.*)",
  // Auth pages must stay public or auth.protect() would bounce /sign-in
  // back to itself in an endless redirect loop.
  "/sign-in(.*)",
  "/sign-up(.*)",
]);

// Built once at module load; Clerk is only initialized when this handler runs.
const clerkHandler = clerkMiddleware(async (auth) => {
  await auth.protect();
});

const middleware: NextMiddleware = async (req, event) => {
  if (isPublicRoute(req)) {
    return NextResponse.next();
  }
  // Next.js always passes the fetch event at runtime; Clerk's handler type
  // marks it non-optional.
  return clerkHandler(req, event as NextFetchEvent);
};

export default middleware;

export const config = {
  matcher: [
    // Skip Next.js internals and all static files unless referenced in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
