import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/*
 * The dashboard and control-plane API are Clerk-protected. The agent
 * endpoints must stay reachable without a browser session because enrolled
 * agents authenticate with their own bearer credential inside the handler,
 * so they are explicitly treated as public here.
 */
const isPublicRoute = createRouteMatcher([
  "/api/agent(.*)",
  "/api/agent/releases(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files unless referenced in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
