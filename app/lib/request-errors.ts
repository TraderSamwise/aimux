export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTransientRequestError(error: unknown): boolean {
  // An error that enumerates what failed is a reported outcome, not a blip.
  // The all-machines-failed error joins each machine's own message, and any
  // one of those can contain "failed to fetch" -- so matching on the text
  // would file a whole fleet being unreachable as something to ignore.
  if (enumeratesPerTargetFailures(error)) return false;
  // Our own requests say what happened rather than leaving it to be read out
  // of a sentence. The patterns below are for errors from outside `api.ts` --
  // fetch's own AbortError, a socket reset -- and they were the only check
  // there was, so when `api.ts` started writing "Request was cancelled (url)"
  // and appending the path to the timeout, both stopped matching and both
  // reached the user as a red banner for something already healed.
  const kind = (error as { kind?: unknown })?.kind;
  if (kind === "cancelled" || kind === "timeout") return true;
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

function enumeratesPerTargetFailures(error: unknown): boolean {
  const body = (error as { body?: unknown })?.body;
  if (!body || typeof body !== "object") return false;
  const failures = (body as { failures?: unknown }).failures;
  return Array.isArray(failures) && failures.length > 0;
}
