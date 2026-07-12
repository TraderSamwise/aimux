export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTransientRequestError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = getErrorMessage(error);
  return (
    name === "AbortError" ||
    /aborted|aborterror|user aborted a request|failed to fetch|network request failed|load failed/i.test(
      message,
    ) ||
    /^request timed out after \d+ms$/i.test(message)
  );
}
