import { auth } from "@clerk/nextjs/server";
import { unauthorized } from "./errors";

/**
 * Resolves the Clerk session for the current request. Route handlers must use
 * this instead of trusting any client-supplied user id.
 *
 * @returns the authenticated Clerk user id
 * @throws ApiError 401 when no session exists
 */
export async function requireUser(): Promise<string> {
  const { userId } = await auth();
  if (!userId) {
    throw unauthorized("Authentication required");
  }
  return userId;
}
