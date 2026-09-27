// Platform-independent half of the toast surface. The renderer differs (sonner
// on web, sonner-native elsewhere); what a toast says must not.

export interface AppToastOptions {
  description?: string;
  duration?: number;
  id?: string | number;
}

const MAX_TOAST_LENGTH = 220;

export function compactToastText(value: string, maxLength = MAX_TOAST_LENGTH): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, maxLength - 1).trim()}…`;
}

// An ApiError carries the status and the daemon's own message; both matter when
// the alternative is a screen that renders the failure as zero results.
interface ApiErrorLike {
  status?: unknown;
  message?: unknown;
  body?: unknown;
}

export function toastErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return compactToastText(error.message);
  if (typeof error === "string" && error.trim()) return compactToastText(error);
  const candidate = error as ApiErrorLike | null;
  if (candidate && typeof candidate.message === "string" && candidate.message.trim()) {
    return compactToastText(candidate.message);
  }
  return fallback;
}

// Repeating "Could not load projects" every ten seconds for an hour is its own
// kind of silence. Keying a toast by what failed replaces the old one instead.
export function toastIdForOperation(operation: string): string {
  return `aimux:${operation}`;
}
