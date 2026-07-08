import { sanitizeLogString } from "./debug.js";

const MAX_ERROR_LINE_LENGTH = 240;

export function userFacingErrorLines(error: unknown): string[] {
  const raw = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeLogString(raw);
  if (/Command failed:\s*tmux\b/i.test(sanitized)) {
    return [
      "tmux failed while updating the managed runtime.",
      "Run aimux restart if it does not recover automatically.",
    ];
  }
  return sanitized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((line) => (line.length > MAX_ERROR_LINE_LENGTH ? `${line.slice(0, MAX_ERROR_LINE_LENGTH - 1)}...` : line));
}

export function userFacingErrorMessage(error: unknown): string {
  return userFacingErrorLines(error).join("\n") || "unknown error";
}
