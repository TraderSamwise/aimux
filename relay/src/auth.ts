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
