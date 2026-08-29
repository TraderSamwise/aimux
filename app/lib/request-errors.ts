export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTransientRequestError(error: unknown): boolean {
  const code =
    typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  const name = error instanceof Error ? error.name : "";
  const message = getErrorMessage(error);
  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    name === "AbortError" ||
    /aborted|aborterror|user aborted a request|failed to fetch|network request failed|load failed|relay not connected|econnreset|epipe|socket hang up/i.test(
      message,
    ) ||
    /^request timed out after \d+ms$/i.test(message)
  );
}
