function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildProjectHookCommand(opts: {
  tool: "claude" | "codex";
  action: string;
  sessionIdFallback?: string;
  endpointFileFallback?: string;
  timeoutSeconds?: number;
}): string {
  const sessionFallback = opts.sessionIdFallback ? shellQuote(opts.sessionIdFallback) : "''";
  const endpointFallback = opts.endpointFileFallback ? shellQuote(opts.endpointFileFallback) : "''";
  const timeoutSeconds = Math.max(1, Math.floor(opts.timeoutSeconds ?? 5));
  const route = `/hooks/${opts.tool}`;
  const action = encodeURIComponent(opts.action);
  const script = [
    "payload=$(cat)",
    'session="${AIMUX_SESSION_ID:-}"',
    `if [ -z "$session" ]; then session=${sessionFallback}; fi`,
    'endpoint_file="${AIMUX_METADATA_ENDPOINT_FILE:-}"',
    `if [ -z "$endpoint_file" ]; then endpoint_file=${endpointFallback}; fi`,
    'if [ -z "$session" ] || [ ! -f "$endpoint_file" ] || ! command -v curl >/dev/null 2>&1; then printf \'{}\\n\'; exit 0; fi',
    'IFS= read -r endpoint < "$endpoint_file" || endpoint=""',
    "if [ -z \"$endpoint\" ]; then printf '{}\\n'; exit 0; fi",
    `url="$endpoint${route}?action=${action}&sessionId=$session"`,
    `printf "%s" "$payload" | curl --silent --show-error --fail --max-time ${timeoutSeconds} -H 'content-type: application/json' --data-binary @- "$url" || printf '{}\\n'`,
  ].join("; ");
  return `sh -lc ${shellQuote(script)}`;
}
