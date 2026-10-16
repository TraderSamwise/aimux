import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Which tool an agent is, in a header with no room for the word.
 *
 * The header renders in two layouts -- a narrow one and a wide one that
 * scrolls -- and both draw the same two lines. A mark added to one of them is
 * a header that tells you the runtime only at some window widths, which is the
 * "One Answer, Many Surfaces" problem in a single file. So the count is the
 * assertion.
 *
 * Read from source because this screen is an Expo Router pane with no renderer
 * in this app. What the mark SAYS is driven for real in
 * `runtime-brand.test.ts`.
 */
const screenSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "screens", "AgentChatScreen.tsx"),
  "utf8",
);

describe("the chat header says which tool", () => {
  it("marks both header layouts, not just one", () => {
    const uses = screenSource.split("<RuntimeBrandMark agent={session} />").length - 1;
    expect(uses).toBe(2);
    const subtitles = screenSource.split("{sessionSubtitle}").length - 1;
    expect(subtitles, "the header still renders two layouts").toBe(2);
    expect(uses, "each layout carries the mark").toBe(subtitles);
  });

  it("rides the second line, which is the only one that already truncates", () => {
    // Line one is the project and worktree title, and it is the line Sam reads
    // first. Line two is a branch name that already middle-ellipsises, so the
    // mark costs it 22pt and the header no height at all.
    for (const line of screenSource.split("{sessionSubtitle}").slice(0, -1)) {
      const window = line.slice(-600);
      expect(window, "the mark sits immediately before the subtitle").toContain(
        "<RuntimeBrandMark agent={session} />",
      );
      expect(window, "and the subtitle keeps its one line and its ellipsis").toMatch(
        /numberOfLines=\{1\}[\s\S]*?ellipsizeMode="middle"/,
      );
      expect(window, "and shrinks around the mark rather than pushing it out").toContain(
        "flexShrink: 1",
      );
    }
  });

  it("does not spend the title line or the action row on it", () => {
    // The action row already overflows the right edge, and the accent rule is
    // the worktree's colour -- a second colour system on 3pt of rule would say
    // two things with one mark.
    for (const title of screenSource.split("{sessionTitle}").slice(0, -1)) {
      expect(title.slice(-400), "line one is untouched").not.toContain("RuntimeBrandMark");
    }
    expect(screenSource, "the accent rule still carries only the worktree tone").toMatch(
      /style=\{\{ width: 3, backgroundColor: headerTone \}\}/,
    );
  });

  it("says nothing about a shared chat, because it knows nothing", () => {
    // `sessionFromActiveShare` fills `toolConfigKey: "shared"`: the receiver
    // is told the owner's session id and project, never which runtime is
    // behind it. "Agent" would read as a classification where there is none,
    // so the mark is absent -- the same reason an unreadable value is not
    // reported as an empty one.
    const marks = screenSource.split("<RuntimeBrandMark agent={session} />").length - 1;
    const gated = screenSource.split("session && !isSharedConversation ? (").length - 1;
    expect(gated, "every mark is behind the ownership check").toBe(marks);
  });

  it("asks the agent, not the route, which tool it is", () => {
    // `agentToolName` is the one answer, mirrored in
    // `native/crates/aimux/src/agent_display.rs`. A header that read
    // `toolConfigKey` itself would be a second opinion.
    expect(screenSource).not.toMatch(/session\?\.(toolConfigKey|command)/);
    expect(screenSource).toContain(
      'import { RuntimeBrandMark } from "@/components/RuntimeBrandMark"',
    );
  });
});
