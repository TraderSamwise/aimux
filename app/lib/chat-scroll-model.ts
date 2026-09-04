export const DEFAULT_CHAT_SCROLL_END_THRESHOLD = 24;
export const DEFAULT_CHAT_SCROLL_REANCHOR_THRESHOLD = 8;

export type ChatPaneKind = "chat" | "terminal";
export type ChatScrollAxis = "normal" | "inverted";
export type ChatScrollContentChangeReason =
  | "append-at-end"
  | "geometry"
  | "prepend-at-start"
  | "replace";
export type ChatScrollUserInput = "blurred" | "focused";

export type ChatScrollIntent =
  | {
      kind: "anchored-to-end";
    }
  | {
      frozenOffset: number;
      kind: "reading-history";
    };

export type ChatScrollGeometry = {
  composerHeight: number;
  endBuffer: number;
  keyboardHeight: number;
  keyboardProgress: number;
  safeAreaBottom: number;
};

export type ChatScrollMetrics = {
  contentLength: number;
  /**
   * Logical scroll offset. Adapters must normalize platform coordinates so the
   * content end is always the maximum offset, even for inverted native lists.
   */
  contentOffset: number;
  viewportLength: number;
};

export type ChatScrollCommand =
  | {
      kind: "none";
    }
  | {
      animated: boolean;
      kind: "scroll-to";
      offset: number;
    };

export type ChatScrollPolicyState = {
  geometry: ChatScrollGeometry;
  intent: ChatScrollIntent;
  metrics: ChatScrollMetrics;
  pane: ChatPaneKind;
};

export type ChatScrollTransition = {
  command: ChatScrollCommand;
  state: ChatScrollPolicyState;
};

export type ChatScrollNativeMetrics = ChatScrollMetrics;

export function createChatScrollPolicyState({
  geometry,
  metrics,
  pane,
}: {
  geometry?: Partial<ChatScrollGeometry>;
  metrics?: Partial<ChatScrollMetrics>;
  pane: ChatPaneKind;
}): ChatScrollPolicyState {
  return {
    geometry: normalizeGeometry(geometry),
    intent: { kind: "anchored-to-end" },
    metrics: normalizeMetrics(metrics),
    pane,
  };
}

export function normalizeGeometry(
  geometry: Partial<ChatScrollGeometry> | undefined,
): ChatScrollGeometry {
  return {
    composerHeight: clampNonNegative(geometry?.composerHeight),
    endBuffer: geometry?.endBuffer ?? DEFAULT_CHAT_SCROLL_END_THRESHOLD,
    keyboardHeight: clampNonNegative(geometry?.keyboardHeight),
    keyboardProgress: clampUnit(geometry?.keyboardProgress),
    safeAreaBottom: clampNonNegative(geometry?.safeAreaBottom),
  };
}

export function normalizeMetrics(
  metrics: Partial<ChatScrollMetrics> | undefined,
): ChatScrollMetrics {
  return {
    contentLength: clampNonNegative(metrics?.contentLength),
    contentOffset: clampNonNegative(metrics?.contentOffset),
    viewportLength: clampNonNegative(metrics?.viewportLength),
  };
}

export function composerOcclusionHeight(geometry: ChatScrollGeometry): number {
  return Math.max(0, geometry.composerHeight + geometry.safeAreaBottom);
}

export function endAnchorInset(geometry: ChatScrollGeometry): number {
  return composerOcclusionHeight(geometry) + Math.max(0, geometry.endBuffer);
}

export function scrollableEndOffset(
  metrics: ChatScrollMetrics,
  geometry: ChatScrollGeometry,
): number {
  return Math.max(0, metrics.contentLength + endAnchorInset(geometry) - metrics.viewportLength);
}

export function distanceFromEnd(metrics: ChatScrollMetrics, geometry: ChatScrollGeometry): number {
  return Math.max(0, scrollableEndOffset(metrics, geometry) - metrics.contentOffset);
}

export function nativeOffsetToLogicalOffset({
  axis,
  geometry,
  metrics,
}: {
  axis: ChatScrollAxis;
  geometry: ChatScrollGeometry;
  metrics: ChatScrollNativeMetrics;
}): number {
  const offset = clampNonNegative(metrics.contentOffset);
  if (axis === "normal") return offset;
  return Math.max(0, scrollableEndOffset(metrics, geometry) - offset);
}

export function logicalOffsetToNativeOffset({
  axis,
  geometry,
  metrics,
  offset,
}: {
  axis: ChatScrollAxis;
  geometry: ChatScrollGeometry;
  metrics: ChatScrollMetrics;
  offset: number;
}): number {
  const logicalOffset = clampNonNegative(offset);
  if (axis === "normal") return logicalOffset;
  return Math.max(0, scrollableEndOffset(metrics, geometry) - logicalOffset);
}

export function nativeMetricsToLogicalMetrics({
  axis,
  geometry,
  metrics,
}: {
  axis: ChatScrollAxis;
  geometry: ChatScrollGeometry;
  metrics: ChatScrollNativeMetrics;
}): ChatScrollMetrics {
  const normalized = normalizeMetrics(metrics);
  return {
    ...normalized,
    contentOffset: nativeOffsetToLogicalOffset({
      axis,
      geometry,
      metrics: normalized,
    }),
  };
}

export function logicalCommandToNativeCommand({
  axis,
  command,
  geometry,
  metrics,
}: {
  axis: ChatScrollAxis;
  command: ChatScrollCommand;
  geometry: ChatScrollGeometry;
  metrics: ChatScrollMetrics;
}): ChatScrollCommand {
  if (command.kind !== "scroll-to") return command;
  return {
    ...command,
    offset: logicalOffsetToNativeOffset({
      axis,
      geometry,
      metrics,
      offset: command.offset,
    }),
  };
}

export function isAnchoredToEnd({
  geometry,
  metrics,
  threshold = DEFAULT_CHAT_SCROLL_END_THRESHOLD,
}: {
  geometry: ChatScrollGeometry;
  metrics: ChatScrollMetrics;
  threshold?: number;
}): boolean {
  return distanceFromEnd(metrics, geometry) <= Math.max(0, threshold);
}

export function onUserScrollBegin(state: ChatScrollPolicyState): ChatScrollPolicyState {
  return {
    ...state,
    intent: {
      frozenOffset: state.metrics.contentOffset,
      kind: "reading-history",
    },
  };
}

export function onUserScroll({
  metrics,
  reanchorThreshold = DEFAULT_CHAT_SCROLL_REANCHOR_THRESHOLD,
  state,
  threshold,
}: {
  metrics: Partial<ChatScrollMetrics>;
  reanchorThreshold?: number;
  state: ChatScrollPolicyState;
  threshold?: number;
}): ChatScrollPolicyState {
  const nextMetrics = normalizeMetrics({ ...state.metrics, ...metrics });
  const anchored = isAnchoredToEnd({
    geometry: state.geometry,
    metrics: nextMetrics,
    threshold:
      state.intent.kind === "reading-history"
        ? Math.min(Math.max(0, reanchorThreshold), threshold ?? DEFAULT_CHAT_SCROLL_END_THRESHOLD)
        : threshold,
  });
  return {
    ...state,
    intent: anchored
      ? { kind: "anchored-to-end" }
      : {
          frozenOffset: nextMetrics.contentOffset,
          kind: "reading-history",
        },
    metrics: nextMetrics,
  };
}

export function onGeometryChange({
  geometry,
  state,
}: {
  geometry: Partial<ChatScrollGeometry>;
  state: ChatScrollPolicyState;
}): ChatScrollTransition {
  const nextState = {
    ...state,
    geometry: normalizeGeometry({ ...state.geometry, ...geometry }),
  };
  return commandForCurrentIntent(nextState, { animated: false });
}

export function onContentChange({
  contentLength,
  reason,
  state,
}: {
  contentLength: number;
  reason: ChatScrollContentChangeReason;
  state: ChatScrollPolicyState;
}): ChatScrollTransition {
  const previousContentLength = state.metrics.contentLength;
  const nextState = {
    ...state,
    metrics: normalizeMetrics({
      ...state.metrics,
      contentLength,
    }),
  };

  if (nextState.intent.kind === "anchored-to-end") {
    return commandForCurrentIntent(nextState, { animated: false });
  }

  if (reason === "prepend-at-start") {
    const delta = Math.max(0, nextState.metrics.contentLength - previousContentLength);
    const frozenOffset = nextState.intent.frozenOffset + delta;
    return {
      command:
        delta > 0 ? { animated: false, kind: "scroll-to", offset: frozenOffset } : { kind: "none" },
      state: {
        ...nextState,
        intent: {
          frozenOffset,
          kind: "reading-history",
        },
      },
    };
  }

  return {
    command: {
      animated: false,
      kind: "scroll-to",
      offset: nextState.intent.frozenOffset,
    },
    state: nextState,
  };
}

export function commandForCurrentIntent(
  state: ChatScrollPolicyState,
  { animated }: { animated: boolean },
): ChatScrollTransition {
  if (state.intent.kind === "anchored-to-end") {
    return {
      command: {
        animated,
        kind: "scroll-to",
        offset: scrollableEndOffset(state.metrics, state.geometry),
      },
      state,
    };
  }
  return {
    command: {
      animated: false,
      kind: "scroll-to",
      offset: state.intent.frozenOffset,
    },
    state,
  };
}

export function composerPresentation({
  input,
  state,
}: {
  input: ChatScrollUserInput;
  state: ChatScrollPolicyState;
}): "scrolled-away" | "visible" {
  if (input === "focused") return "visible";
  return state.intent.kind === "reading-history" ? "scrolled-away" : "visible";
}

function clampNonNegative(value: number | undefined): number {
  return Math.max(0, value ?? 0);
}

function clampUnit(value: number | undefined): number {
  return Math.min(1, Math.max(0, value ?? 0));
}
