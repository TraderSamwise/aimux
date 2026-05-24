export function buildSecurityPushRegistrationUrl(
  relayUrl: string,
  options: { ownerUserId?: string; shareId?: string } = {},
): URL {
  const url = new URL(`${relayUrl.replace(/^ws/, "http").replace(/\/+$/, "")}/security/push-token`);
  if (options.ownerUserId) url.searchParams.set("ownerUserId", options.ownerUserId);
  if (options.shareId) url.searchParams.set("shareId", options.shareId);
  return url;
}
