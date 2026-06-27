const CLIENT_SESSION_SUFFIX_PATTERN = /-client-[a-f0-9]{8}$/;

export function isTmuxClientSessionName(sessionName: string): boolean {
  return CLIENT_SESSION_SUFFIX_PATTERN.test(sessionName);
}

export function isTmuxClientSessionForHost(sessionName: string, hostSessionName: string): boolean {
  const prefix = `${hostSessionName}-client-`;
  if (!sessionName.startsWith(prefix)) return false;
  return /^[a-f0-9]{8}$/.test(sessionName.slice(prefix.length));
}
