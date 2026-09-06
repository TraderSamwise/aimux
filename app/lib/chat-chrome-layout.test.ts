import { describe, expect, it } from "vitest";

import {
  CHAT_PAIRING_BANNER_HEIGHT,
  CHAT_RECONNECTING_PANEL_RESERVE,
  CHAT_SESSION_HEADER_HEIGHT,
  CHAT_SHARE_PANEL_COLLAPSED_RESERVE,
  CHAT_TOP_BAR_BASE_HEIGHT,
  chatControlPanelReserveHeight,
  chatOverlayPanelReserveHeight,
  chatTopBarReserveHeight,
  chatTranscriptTopReserveHeight,
} from "./chat-chrome-layout";

describe("chat chrome layout", () => {
  it("reserves the fixed top bar and optional pairing banner", () => {
    expect(chatTopBarReserveHeight({ pairingBannerVisible: false, topInset: 54 })).toBe(
      CHAT_TOP_BAR_BASE_HEIGHT + 54,
    );
    expect(chatTopBarReserveHeight({ pairingBannerVisible: true, topInset: 54 })).toBe(
      CHAT_TOP_BAR_BASE_HEIGHT + 54 + CHAT_PAIRING_BANNER_HEIGHT,
    );
  });

  it("reserves session header plus open overlays without measuring rendered height", () => {
    expect(
      chatTranscriptTopReserveHeight({
        pairingBannerVisible: true,
        panelReserveHeight: 200,
        topInset: 54,
      }),
    ).toBe(
      CHAT_TOP_BAR_BASE_HEIGHT + 54 + CHAT_PAIRING_BANNER_HEIGHT + 200 + CHAT_SESSION_HEADER_HEIGHT,
    );
  });

  it("reserves reconnect plus the largest active control panel", () => {
    expect(
      chatOverlayPanelReserveHeight({
        manageOpen: false,
        serviceDisconnected: false,
        shareDetailsExpanded: false,
        shareOpen: true,
        windowHeight: 900,
      }),
    ).toBe(CHAT_SHARE_PANEL_COLLAPSED_RESERVE);

    expect(
      chatOverlayPanelReserveHeight({
        manageOpen: false,
        serviceDisconnected: true,
        shareDetailsExpanded: false,
        shareOpen: false,
        windowHeight: 900,
      }),
    ).toBe(CHAT_RECONNECTING_PANEL_RESERVE);

    expect(
      chatOverlayPanelReserveHeight({
        manageOpen: true,
        serviceDisconnected: true,
        shareDetailsExpanded: true,
        shareOpen: true,
        windowHeight: 900,
      }),
    ).toBe(598);
  });

  it("keeps control panel height separate from total overlay reserve", () => {
    const args = {
      manageOpen: false,
      shareDetailsExpanded: true,
      shareOpen: true,
      windowHeight: 900,
    };

    expect(chatControlPanelReserveHeight(args)).toBe(432);
    expect(chatOverlayPanelReserveHeight({ ...args, serviceDisconnected: true })).toBe(
      CHAT_RECONNECTING_PANEL_RESERVE + 432,
    );
  });
});
