import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The two panes must agree about where "the end" is.
 *
 * The chat transcript and the terminal output sit side by side in one screen
 * and answer the same question -- is the reader at the newest content -- and
 * for a while they answered it differently. The terminal took the keyboard and
 * composer contentInset into account on both sides; the chat pane took it on
 * neither, so it scrolled with bare `scrollToEnd`, landed short of the end by
 * the whole composer reserve, and the next scroll event read that gap as
 * scrollback. Opening a chat with a long transcript left the reader mid-history
 * with the pane frozen, which is what a notification tap did every time.
 *
 * Read from source because this screen is an Expo Router pane with no renderer
 * in this app. The RULES are driven for real in `chat-scroll-policy.test.ts`;
 * what source can still say is that both panes ask the same rules.
 */
const screenSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "screens", "AgentChatScreen.tsx"),
  "utf8",
);

/** The body of one `useCallback`-wrapped handler, comments stripped. */
function handlerBody(name: string): string {
  const file = screenSource.replace(/^\s*\/\/.*$/gm, "");
  const opener = file.indexOf(`const ${name} = useCallback(`);
  expect(opener, `${name} is still a handler in this screen`).toBeGreaterThan(-1);
  let depth = 0;
  for (let index = file.indexOf("(", opener); index < file.length; index += 1) {
    if (file[index] === "(") depth += 1;
    else if (file[index] === ")") {
      depth -= 1;
      if (depth === 0) return file.slice(opener, index + 1);
    }
  }
  throw new Error(`unbalanced parentheses in ${name}`);
}

describe("both panes scroll to the same end", () => {
  it("targets the inset-aware end, and only once the pane is measured", () => {
    for (const [pane, geometry] of [
      ["executeChatScrollCommand", "chatScrollMetricsRef.current"],
      ["executeTerminalScrollCommand", "terminalGeometryRef.current"],
    ]) {
      const body = handlerBody(pane);
      // The whole decision, from the pane's own geometry. A pane that asked
      // `chatScrollTargetForEnd` directly and trusted `target > 0` scrolled to
      // the INSET on a fresh mount -- a couple of hundred points from the top
      // of the history -- because the library's inset callback can arrive
      // before the first layout.
      expect(body, `${pane} must ask where the end is, measured`).toContain(
        `chatScrollEndOffset(${geometry})`,
      );
      expect(body, `${pane} must not compute the end itself`).not.toContain(
        "chatScrollTargetForEnd(",
      );
      // Null is "not measured yet", and the native command is the fallback.
      expect(body).toMatch(/target === null[\s\S]*?scrollToEnd\(/);
      expect(body).toMatch(/scrollTo\(\{ animated: command\.animated, y: target \}\)/);
    }
  });

  it("measures the pane before it decides where the end is", () => {
    // Order, not presence. Writing the viewport height BELOW the branch left
    // the `initial` command -- the one that is supposed to run on measured
    // geometry -- computing from a height of zero, which is no target at all
    // and so a bare `scrollToEnd` again.
    expect(handlerBody("handleChatLayout")).toMatch(
      /viewportHeight: event\.nativeEvent\.layout\.height[\s\S]*?chatInitialLayoutKeyRef\.current !== agentKey[\s\S]*?chatCommandForInitialLayout\(\)/,
    );
    expect(handlerBody("handleTerminalLayout")).toMatch(
      /viewportHeight: event\.nativeEvent\.layout\.height[\s\S]*?terminalInitialLayoutKeyRef\.current !== agentKey/,
    );
    // And the content height has exactly one writer before the first scroll
    // event: dropping it leaves every landing command with nothing measured.
    expect(handlerBody("handleChatContentSizeChange")).toContain(
      "chatScrollMetricsRef.current = {",
    );
    expect(handlerBody("handleChatContentSizeChange")).toContain("contentHeight,");
    expect(handlerBody("handleTerminalContentSizeChange")).toContain(
      "terminalGeometryRef.current = {",
    );
    expect(handlerBody("handleTerminalContentSizeChange")).toContain("contentHeight }");
  });

  it("leaves the first layout after focus its landing, and only then", () => {
    // Claiming the layout key on focus made `handleChatLayout` take the
    // content branch, so the only landing happened before anything had been
    // measured. Clearing it unconditionally is the other mistake: a re-focus
    // with no remount would leave the next layout change -- a composer growing
    // a line -- to fire an `initial` scroll at a reader who has since scrolled
    // up. So it is decided from whether the pane has been measured.
    expect(screenSource).toMatch(
      /chatInitialLayoutKeyRef\.current =\s*chatScrollEndOffset\(chatScrollMetricsRef\.current\) === null \? null : agentKey;/,
    );
    // One claim, in the handler that has been measured.
    expect(screenSource.split("chatInitialLayoutKeyRef.current = agentKey").length - 1).toBe(1);
  });

  it("records the inset the library reports, into the geometry it scrolls by", () => {
    // Android does not put the keyboard-driven inset in the scroll event, so
    // the only way to know it is the callback. Spelled out exactly: writing
    // `insets.bottom` into anything but the geometry the scroll target is
    // computed from reads the same and records nothing, and `bottomInset: 0`
    // satisfies any looser assertion.
    expect(handlerBody("handleChatContentInsetChange")).toContain(
      "chatScrollMetricsRef.current = {",
    );
    expect(handlerBody("handleTerminalContentInsetChange")).toContain(
      "terminalGeometryRef.current = {",
    );
    for (const handler of ["handleChatContentInsetChange", "handleTerminalContentInsetChange"]) {
      expect(handlerBody(handler)).toContain("bottomInset: insets.bottom");
    }
    expect(handlerBody("handleChatScroll")).toContain(
      "bottomInset: chatScrollMetricsRef.current.bottomInset",
    );
    expect(handlerBody("handleTerminalScroll")).toContain(
      "bottomInset: terminalGeometryRef.current.bottomInset",
    );
    expect(screenSource).toContain("onContentInsetChange={handleChatContentInsetChange}");
    expect(screenSource).toContain("onContentInsetChange={handleTerminalContentInsetChange}");
  });

  it("re-lands when the inset arrives, because it arrives late", () => {
    // The library reports the inset through a Reanimated reaction, so it can
    // land after every scroll has already run against an inset of zero -- each
    // of them short by the composer reserve. The next scroll event measures
    // that gap against the new inset, reads it as scrollback, and freezes the
    // pane mid-history. Recording the number is not enough; the pane has to
    // act on it, and `keyboard` is the reason that moves only a reader who has
    // not scrolled away.
    for (const [handler, policy] of [
      ["handleChatContentInsetChange", "chatScrollPolicyRef.current"],
      ["handleTerminalContentInsetChange", "terminalScrollPolicyRef.current"],
    ]) {
      const body = handlerBody(handler);
      expect(body, `${handler} must act on the inset it just learned`).toContain(
        `chatCommandForKeyboardChange(${policy})`,
      );
      // And not on every report of the same number.
      expect(body).toMatch(/bottomInset === insets\.bottom\) return;/);
    }
  });

  it("lets a landing scroll survive a scroll event that arrives mid-flight", () => {
    // Both panes used to cancel any queued command the moment one event read
    // as scrollback -- including the `initial` and `navigation` scrolls that
    // are what take the reader to the newest message in the first place.
    for (const handler of ["handleChatScroll", "handleTerminalScroll"]) {
      const body = handlerBody(handler);
      expect(body, `${handler} must consult the shared rule before cancelling`).toMatch(
        /chatScrollCommandRunsWhileUnpinned\([a-zA-Z]*PendingCommandReasonRef\.current\)/,
      );
    }
    // And the rule is asked, not restated, in the frames that run them.
    for (const pane of ["executeChatScrollCommand", "executeTerminalScrollCommand"]) {
      const body = handlerBody(pane);
      expect(body).toContain("chatScrollCommandRunsWhileUnpinned(command.reason)");
      expect(body, "the reasons must not be spelled out a second time").not.toMatch(
        /reason !== "initial"/,
      );
    }
  });
});
