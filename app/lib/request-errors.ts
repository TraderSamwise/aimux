export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTransientRequestError(error: unknown): boolean {
  // An error that enumerates what failed is a reported outcome, not a blip.
  // The all-machines-failed error joins each machine's own message, and any
  // one of those can contain "failed to fetch" -- so matching on the text
  // would file a whole fleet being unreachable as something to ignore.
  if (enumeratesPerTargetFailures(error)) return false;
  // Our own requests say when the app abandoned them, rather than leaving it
  // to be read back out of a sentence. The patterns below are for errors from
  // outside `api.ts` -- fetch's own AbortError, a socket reset -- and they
  // were the only check there was, so when `api.ts` started writing "Request
  // was cancelled (url)" the match stopped and a request the app cancelled on
  // purpose reached the user as a red banner.
  //
  // Only cancellation. A timeout is a real failure, and this filter also
  // guards user-initiated actions (agent-actions.tsx, agent-create-panel.tsx),
  // where hiding one leaves a stop button that spins, stops, and says nothing.
  if ((error as { kind?: unknown })?.kind === "cancelled") return true;
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
