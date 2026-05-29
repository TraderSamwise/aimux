import type { Href } from "expo-router";

export function clerkErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === "object" && err && "errors" in err) {
    const errors = (
      err as {
        errors?: Array<{
          longMessage?: string;
          long_message?: string;
          message?: string;
        }>;
      }
    ).errors;
    const first = errors?.[0];
    return first?.longMessage ?? first?.long_message ?? first?.message ?? fallback;
  }
  return fallback;
}

export function sanitizeRedirect(value: string | undefined): Href | null {
  if (!value) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  return value as Href;
}
