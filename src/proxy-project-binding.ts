/**
 * Which project owns a proxied service port.
 *
 * Hosted grants name a project root and a session id together, because session
 * ids are unique only within a project. Binding the port back to a root is what
 * stops a grant in one project from authorizing the same session name in
 * another, so this resolution is an authorization input and fails closed.
 */

export interface ProxyBindingCandidate {
  path: string;
  serviceAlive: boolean;
  serviceEndpoint: { host: string; port: number } | null;
}

export interface ProxyTarget {
  host: string;
  port: number;
  /** The route beneath the proxy prefix, parsed once so callers cannot disagree. */
  subPath: string;
}

/**
 * Endpoint records are files that outlive the process that wrote them — an
 * ungraceful exit leaves one behind, and services listen on ephemeral ports
 * that the OS recycles. Matching on a recorded port alone could therefore hand
 * back a dead project whose old port now belongs to a live one, so a candidate
 * must still be alive, and an ambiguous match resolves to nothing at all.
 *
 * INVARIANT: the caller must forward to the same `host:port` it passed in here.
 * This answers "which project owns that target", not "where should the request
 * go" — resolving one from the endpoint record and forwarding to the other
 * would authorize against one service and talk to another, which is a
 * request-controlled loopback fetch with an operator's authorization attached.
 */
export function resolveProjectRootForServiceTarget(
  candidates: readonly ProxyBindingCandidate[],
  target: ProxyTarget | null,
): string | null {
  if (!target) return null;
  const { host, port } = target;
  if (!Number.isInteger(port) || port <= 0 || !host) return null;

  // Host is matched exactly rather than resolved: "localhost" can answer on
  // ::1, which is a different listener from the 127.0.0.1 an endpoint records.
  const matches = candidates.filter(
    (candidate) =>
      candidate.serviceAlive &&
      candidate.serviceEndpoint?.port === port &&
      candidate.serviceEndpoint?.host === host &&
      Boolean(candidate.path),
  );
  return matches.length === 1 ? matches[0]!.path : null;
}

export function parseProxyTarget(pathname: string): ProxyTarget | null {
  const match = pathname.match(/^\/proxy\/([^/]+)\/(\d+)(\/.*)/);
  if (!match) return null;
  const port = Number.parseInt(match[2]!, 10);
  if (!Number.isInteger(port) || port <= 0) return null;
  return { host: match[1]!, port, subPath: match[3]! };
}
