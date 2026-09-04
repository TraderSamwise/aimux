import { describe, expect, it } from "vitest";

import {
  commandForCurrentIntent,
  composerPresentation,
  createChatScrollPolicyState,
  distanceFromEnd,
  endAnchorInset,
  isAnchoredToEnd,
  logicalCommandToNativeCommand,
  nativeMetricsToLogicalMetrics,
  onContentChange,
  onGeometryChange,
  onUserScroll,
  onUserScrollBegin,
  scrollableEndOffset,
} from "./chat-scroll-model";

describe("chat scroll model", () => {
  it("pins the end above the measured composer plus buffer", () => {
    const state = createChatScrollPolicyState({
      pane: "chat",
      geometry: {
        composerHeight: 120,
        endBuffer: 32,
        safeAreaBottom: 10,
      },
      metrics: {
        contentLength: 900,
        viewportLength: 600,
      },
    });

    expect(endAnchorInset(state.geometry)).toBe(162);
    expect(scrollableEndOffset(state.metrics, state.geometry)).toBe(462);
    expect(commandForCurrentIntent(state, { animated: false }).command).toEqual({
      animated: false,
      kind: "scroll-to",
      offset: 462,
    });
  });

  it("keeps new output pinned when the user has not left the end", () => {
    const state = createChatScrollPolicyState({
      pane: "terminal",
      geometry: { composerHeight: 100, endBuffer: 24 },
      metrics: { contentLength: 600, contentOffset: 124, viewportLength: 600 },
    });

    expect(distanceFromEnd(state.metrics, state.geometry)).toBe(0);
    const next = onContentChange({
      contentLength: 720,
      reason: "append-at-end",
      state,
    });

    expect(next.state.intent).toEqual({ kind: "anchored-to-end" });
    expect(next.command).toEqual({
      animated: false,
      kind: "scroll-to",
      offset: 244,
    });
  });

  it("freezes scroll when the user scrolls into history", () => {
    const anchored = createChatScrollPolicyState({
      pane: "chat",
      geometry: { composerHeight: 120, endBuffer: 24 },
      metrics: { contentLength: 1200, contentOffset: 724, viewportLength: 500 },
    });

    const reading = onUserScroll({
      metrics: { contentOffset: 300 },
      state: onUserScrollBegin(anchored),
    });
    const next = onContentChange({
      contentLength: 1400,
      reason: "append-at-end",
      state: reading,
    });

    expect(next.state.intent).toEqual({
      frozenOffset: 300,
      kind: "reading-history",
    });
    expect(next.command).toEqual({ kind: "none" });
  });

  it("restores anchored intent when the user returns to the end", () => {
    const state = createChatScrollPolicyState({
      pane: "terminal",
      geometry: { composerHeight: 90, endBuffer: 20 },
      metrics: { contentLength: 1000, contentOffset: 0, viewportLength: 500 },
    });

    const reading = onUserScroll({
      metrics: { contentOffset: 200 },
      state: onUserScrollBegin(state),
    });
    const anchored = onUserScroll({
      metrics: { contentOffset: 610 },
      state: reading,
    });

    expect(isAnchoredToEnd({ geometry: anchored.geometry, metrics: anchored.metrics })).toBe(true);
    expect(anchored.intent).toEqual({ kind: "anchored-to-end" });
  });

  it("does not re-anchor from history until the user is very close to the end", () => {
    const state = createChatScrollPolicyState({
      pane: "chat",
      geometry: { composerHeight: 90, endBuffer: 20 },
      metrics: { contentLength: 1000, contentOffset: 610, viewportLength: 500 },
    });

    const reading = onUserScroll({
      metrics: { contentOffset: 500 },
      state: onUserScrollBegin(state),
    });
    const nearEnd = onUserScroll({
      metrics: { contentOffset: 590 },
      state: reading,
      threshold: 24,
      reanchorThreshold: 8,
    });
    const atEnd = onUserScroll({
      metrics: { contentOffset: 604 },
      state: nearEnd,
      threshold: 24,
      reanchorThreshold: 8,
    });

    expect(nearEnd.intent).toEqual({
      frozenOffset: 590,
      kind: "reading-history",
    });
    expect(atEnd.intent).toEqual({ kind: "anchored-to-end" });
  });

  it("does not force-scroll during keyboard or composer geometry changes while reading history", () => {
    const state = onUserScroll({
      metrics: { contentOffset: 250 },
      state: onUserScrollBegin(
        createChatScrollPolicyState({
          pane: "chat",
          geometry: { composerHeight: 120, endBuffer: 24, keyboardHeight: 0 },
          metrics: { contentLength: 1000, contentOffset: 524, viewportLength: 500 },
        }),
      ),
    });

    const next = onGeometryChange({
      geometry: { composerHeight: 80, keyboardHeight: 320, keyboardProgress: 1 },
      state,
    });

    expect(next.state.intent).toEqual({
      frozenOffset: 250,
      kind: "reading-history",
    });
    expect(next.command).toEqual({ kind: "none" });
  });

  it("re-pins after keyboard or composer geometry changes while anchored", () => {
    const state = createChatScrollPolicyState({
      pane: "chat",
      geometry: { composerHeight: 100, endBuffer: 24 },
      metrics: { contentLength: 1000, contentOffset: 624, viewportLength: 500 },
    });

    const next = onGeometryChange({
      geometry: { composerHeight: 140, keyboardHeight: 300, keyboardProgress: 1 },
      state,
    });

    expect(next.command).toEqual({
      animated: false,
      kind: "scroll-to",
      offset: 664,
    });
  });

  it("preserves visible content when older history is prepended while reading", () => {
    const reading = onUserScroll({
      metrics: { contentOffset: 260 },
      state: onUserScrollBegin(
        createChatScrollPolicyState({
          pane: "chat",
          geometry: { composerHeight: 100, endBuffer: 24 },
          metrics: { contentLength: 900, contentOffset: 524, viewportLength: 500 },
        }),
      ),
    });

    const next = onContentChange({
      contentLength: 1220,
      reason: "prepend-at-start",
      state: reading,
    });

    expect(next.command).toEqual({
      animated: false,
      kind: "scroll-to",
      offset: 580,
    });
    expect(next.state.intent).toEqual({
      frozenOffset: 580,
      kind: "reading-history",
    });
  });

  it("normalizes native metrics to logical coordinates for normal and inverted views", () => {
    const state = createChatScrollPolicyState({
      pane: "chat",
      geometry: { composerHeight: 120, endBuffer: 24 },
      metrics: { contentLength: 1000, viewportLength: 500 },
    });

    expect(
      nativeMetricsToLogicalMetrics({
        axis: "normal",
        geometry: state.geometry,
        metrics: { contentLength: 1000, contentOffset: 120, viewportLength: 500 },
      }),
    ).toEqual({ contentLength: 1000, contentOffset: 120, viewportLength: 500 });
    expect(
      nativeMetricsToLogicalMetrics({
        axis: "inverted",
        geometry: state.geometry,
        metrics: { contentLength: 1000, contentOffset: 0, viewportLength: 500 },
      }).contentOffset,
    ).toBe(scrollableEndOffset(state.metrics, state.geometry));

    const invertedMidHistory = nativeMetricsToLogicalMetrics({
      axis: "inverted",
      geometry: state.geometry,
      metrics: { contentLength: 1000, contentOffset: 200, viewportLength: 500 },
    });
    expect(invertedMidHistory.contentOffset).toBe(444);
    expect(
      logicalCommandToNativeCommand({
        axis: "inverted",
        command: {
          animated: false,
          kind: "scroll-to",
          offset: invertedMidHistory.contentOffset,
        },
        geometry: state.geometry,
        metrics: state.metrics,
      }),
    ).toEqual({ animated: false, kind: "scroll-to", offset: 200 });
  });

  it("maps logical commands back to native coordinates for inverted views", () => {
    const state = createChatScrollPolicyState({
      pane: "chat",
      geometry: { composerHeight: 120, endBuffer: 24 },
      metrics: { contentLength: 1000, viewportLength: 500 },
    });
    const logicalEndCommand = {
      animated: false,
      kind: "scroll-to" as const,
      offset: scrollableEndOffset(state.metrics, state.geometry),
    };

    expect(
      logicalCommandToNativeCommand({
        axis: "normal",
        command: logicalEndCommand,
        geometry: state.geometry,
        metrics: state.metrics,
      }),
    ).toEqual(logicalEndCommand);
    expect(
      logicalCommandToNativeCommand({
        axis: "inverted",
        command: logicalEndCommand,
        geometry: state.geometry,
        metrics: state.metrics,
      }),
    ).toEqual({ animated: false, kind: "scroll-to", offset: 0 });
  });

  it("maps logical prepend preservation to native coordinates for inverted views", () => {
    const reading = onUserScroll({
      metrics: { contentOffset: 260 },
      state: onUserScrollBegin(
        createChatScrollPolicyState({
          pane: "chat",
          geometry: { composerHeight: 100, endBuffer: 24 },
          metrics: { contentLength: 900, contentOffset: 524, viewportLength: 500 },
        }),
      ),
    });
    const next = onContentChange({
      contentLength: 1220,
      reason: "prepend-at-start",
      state: reading,
    });

    expect(
      logicalCommandToNativeCommand({
        axis: "inverted",
        command: next.command,
        geometry: next.state.geometry,
        metrics: next.state.metrics,
      }),
    ).toEqual({ animated: false, kind: "scroll-to", offset: 264 });
  });

  it("drives composer visibility from scroll intent and input focus", () => {
    const state = createChatScrollPolicyState({
      pane: "chat",
      metrics: { contentLength: 1000, contentOffset: 400, viewportLength: 500 },
    });
    const reading = onUserScroll({
      metrics: { contentOffset: 100 },
      state: onUserScrollBegin(state),
    });

    expect(composerPresentation({ input: "blurred", state })).toBe("visible");
    expect(composerPresentation({ input: "blurred", state: reading })).toBe("scrolled-away");
    expect(composerPresentation({ input: "focused", state: reading })).toBe("visible");
  });
});
