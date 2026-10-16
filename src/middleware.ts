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

/*
 * The standalone server binds to HOSTNAME=0.0.0.0 in the container, and
 * Next.js then reports req.url as http://0.0.0.0:3000/... Build origins from
 * the request headers instead so redirects never hand the browser an
 * unroutable address.
 */
const requestOrigin = (req: { url: string; headers: Headers }): string => {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) {
    return new URL(req.url).origin;
  }
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
};

// Built once at module load; Clerk is only initialized when this handler runs.
const clerkHandler = clerkMiddleware(async (auth, req) => {
  const { userId } = await auth();
  if (userId) {
    return;
  }

  // API consumers are not browsers: keep Clerk's default for them
  // (404/401 when unauthenticated) instead of an HTML redirect.
  if (req.nextUrl.pathname.startsWith("/api")) {
    await auth.protect();
    return;
  }

  // auth.protect() only redirects requests it recognises as page
  // navigations (Accept: text/html / sec-fetch-dest: document) and rewrites
  // everything else to a 404. Redirect explicitly so unauthenticated deep
  // links always land on the public sign-in page with a return URL.
  const origin = requestOrigin(req);
  const signInUrl = new URL("/sign-in", origin);
  signInUrl.searchParams.set("redirect_url", `${origin}${req.nextUrl.pathname}${req.nextUrl.search}`);
  return NextResponse.redirect(signInUrl);
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
