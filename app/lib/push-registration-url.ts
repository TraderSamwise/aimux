export function buildSecurityPushRegistrationUrl(
  relayUrl: string,
  options: { ownerUserId?: string; shareId?: string } = {},
): URL {
  return buildSecurityPushUrl(relayUrl, "/security/push-token", options);
}

export function buildSecurityPushTestUrl(
  relayUrl: string,
  options: { ownerUserId?: string; shareId?: string } = {},
): URL {
  return buildSecurityPushUrl(relayUrl, "/security/test-push", options);
}

function buildSecurityPushUrl(
  relayUrl: string,
  pathname: string,
  options: { ownerUserId?: string; shareId?: string },
): URL {
  const url = new URL(`${relayUrl.replace(/^ws/, "http").replace(/\/+$/, "")}${pathname}`);
  const ownerUserId = options.ownerUserId?.trim();
  const shareId = options.shareId?.trim();
  if (Boolean(ownerUserId) !== Boolean(shareId)) {
    throw new Error("ownerUserId and shareId must be provided together");
  }
  if (ownerUserId && shareId) {
    url.searchParams.set("ownerUserId", ownerUserId);
    url.searchParams.set("shareId", shareId);
  }
  return url;
}
