import { verifyToken } from "@clerk/backend";
import type { Env } from "./types.js";

export async function verifyWsToken(token: string, env: Env): Promise<string> {
  if (!env.CLERK_SECRET_KEY) {
    throw new Error("CLERK_SECRET_KEY not configured");
  }
  const payload = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
  return payload.sub;
}
