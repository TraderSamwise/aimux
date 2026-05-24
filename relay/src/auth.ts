import { verifyToken } from "@clerk/backend";
import type { Env } from "./types.js";

export async function verifyWsToken(token: string, env: Env): Promise<string> {
  if (!env.CLERK_SECRET_KEY) {
    throw new Error("CLERK_SECRET_KEY not configured");
  }
  const result = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
  const maybeResult = result as { data?: { sub?: string }; errors?: unknown[]; sub?: string };
  if (maybeResult.errors?.length) throw new Error("Invalid Clerk token");
  const sub = maybeResult.data?.sub ?? maybeResult.sub;
  if (!sub) throw new Error("Invalid Clerk token");
  return sub;
}

interface ClerkUserResponse {
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: Array<{ id: string; email_address: string }>;
}

export interface ClerkUserProfile {
  userId: string;
  displayName: string;
  email?: string;
}

export async function fetchClerkUserProfile(env: Env, userId: string): Promise<ClerkUserProfile> {
  if (!env.CLERK_SECRET_KEY) {
    throw new Error("CLERK_SECRET_KEY not configured");
  }
  const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
  });
  if (!res.ok) {
    return { userId, displayName: userId };
  }
  const user = (await res.json()) as ClerkUserResponse;
  const email = primaryEmail(user);
  const displayName =
    [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username || email || userId;
  return { userId, displayName, email: email ?? undefined };
}

function primaryEmail(user: ClerkUserResponse): string | null {
  const primary = user.email_addresses?.find((email) => email.id === user.primary_email_address_id);
  return primary?.email_address ?? user.email_addresses?.[0]?.email_address ?? null;
}
