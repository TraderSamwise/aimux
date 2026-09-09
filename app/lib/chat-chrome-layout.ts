export const CHAT_TOP_BAR_BASE_HEIGHT = 56;
export const CHAT_PAIRING_BANNER_HEIGHT = 48;
export const CHAT_SESSION_HEADER_HEIGHT = 72;
export const CHAT_RECONNECTING_PANEL_RESERVE = 58;
export const CHAT_SHARE_PANEL_COLLAPSED_RESERVE = 68;
export const CHAT_SHARE_PANEL_EXPANDED_HEIGHT_RATIO = 0.48;
export const CHAT_MANAGE_PANEL_HEIGHT_RATIO = 0.6;

export function chatTopBarReserveHeight({
  pairingBannerVisible,
  topInset,
}: {
  pairingBannerVisible: boolean;
  topInset: number;
}): number {
  return (
    CHAT_TOP_BAR_BASE_HEIGHT + topInset + (pairingBannerVisible ? CHAT_PAIRING_BANNER_HEIGHT : 0)
  );
}

export function chatOverlayPanelReserveHeight({
  manageOpen,
  serviceDisconnected,
  shareDetailsExpanded,
  shareOpen,
  windowHeight,
}: {
  manageOpen: boolean;
  serviceDisconnected: boolean;
  shareDetailsExpanded: boolean;
  shareOpen: boolean;
  windowHeight: number;
}): number {
  return (
    (serviceDisconnected ? CHAT_RECONNECTING_PANEL_RESERVE : 0) +
    chatControlPanelReserveHeight({
      manageOpen,
      shareDetailsExpanded,
      shareOpen,
      windowHeight,
    })
  );
}

export function chatControlPanelReserveHeight({
  manageOpen,
  shareDetailsExpanded,
  shareOpen,
  windowHeight,
}: {
  manageOpen: boolean;
  shareDetailsExpanded: boolean;
  shareOpen: boolean;
  windowHeight: number;
}): number {
  const controlPanelReserves: number[] = [];
  if (manageOpen)
    controlPanelReserves.push(Math.round(windowHeight * CHAT_MANAGE_PANEL_HEIGHT_RATIO));
  if (shareOpen) {
    controlPanelReserves.push(
      shareDetailsExpanded
        ? Math.round(windowHeight * CHAT_SHARE_PANEL_EXPANDED_HEIGHT_RATIO)
        : CHAT_SHARE_PANEL_COLLAPSED_RESERVE,
    );
  }
  return Math.max(0, ...controlPanelReserves);
}

export function chatTranscriptTopReserveHeight({
  panelReserveHeight,
  pairingBannerVisible,
  topInset,
}: {
  panelReserveHeight: number;
  pairingBannerVisible: boolean;
  topInset: number;
}): number {
  return (
    chatTopBarReserveHeight({ pairingBannerVisible, topInset }) +
    CHAT_SESSION_HEADER_HEIGHT +
    panelReserveHeight
  );
}
