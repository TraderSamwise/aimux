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
  const actionQuery = shellQuote(`action=${opts.action}`);
  const script = [
    "payload=$(cat)",
    `fail() { printf '%s\\n' "aimux hook $1" >&2; printf '{}\\n'; exit 0; }`,
    'session="${AIMUX_SESSION_ID:-}"',
    `if [ -z "$session" ]; then session=${sessionFallback}; fi`,
    'endpoint_file="${AIMUX_METADATA_ENDPOINT_FILE:-}"',
    `if [ -z "$endpoint_file" ]; then endpoint_file=${endpointFallback}; fi`,
    `if [ -z "$session" ]; then fail 'missing session id'; fi`,
    `if [ ! -f "$endpoint_file" ]; then fail 'missing endpoint file'; fi`,
    `if ! command -v curl >/dev/null 2>&1; then fail 'missing curl'; fi`,
    'IFS= read -r endpoint < "$endpoint_file" || endpoint=""',
    `if [ -z "$endpoint" ]; then fail 'empty endpoint'; fi`,
    `url="$endpoint${route}"`,
    `printf "%s" "$payload" | curl --silent --show-error --fail --max-time ${timeoutSeconds} -H 'content-type: application/json' --data-binary @- --url-query ${actionQuery} --url-query "sessionId=$session" "$url" || fail 'post failed'`,
  ].join("; ");
  return `sh -lc ${shellQuote(script)}`;
}
