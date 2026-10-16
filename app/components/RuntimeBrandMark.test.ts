import { describe, expect, it, vi } from "vitest";

// `react-native` is Flow, which this runner cannot parse -- which is why this
// app "has no render environment". Mocked down to the two host components this
// mark uses, which is enough: the thing under test is a function returning an
// element tree, and the tree is a plain object.
vi.mock("react-native", () => ({ View: "View" }));
vi.mock("@/components/ui/text", () => ({ Text: "Text" }));

const { RUNTIME_BRAND_MARK_WIDTH, RuntimeBrandMark } =
  await import("@/components/RuntimeBrandMark");
const { runtimeBrandForTool } = await import("@/lib/runtime-brand");

/**
 * The mark itself, called rather than rendered.
 *
 * `app/` has no renderer, but a presentational component is a function
 * returning an element tree, and that tree is a plain object. Calling it is
 * enough to catch everything a source gate could not: `return null`, a zero
 * size, `opacity: 0`, the full word in a 22pt box, or the brand taken from the
 * wrong field. An adversarial review landed all five while every assertion
 * about the screen stayed green.
 */
type Element = {
  props: Record<string, unknown> & { children?: unknown; style?: Record<string, unknown> };
};

function mark(agent: Parameters<typeof RuntimeBrandMark>[0]["agent"]): Element {
  const element = RuntimeBrandMark({ agent }) as unknown as Element | null;
  expect(element, "the mark must render something").not.toBeNull();
  return element as Element;
}

function innerText(element: Element): string {
  const child = element.props.children as Element;
  expect(child, "the mark carries one text child").toBeTruthy();
  return child.props.children as string;
}

describe("the runtime brand mark", () => {
  it("shows the two letters, never the word", () => {
    const claude = mark({ toolConfigKey: "claude" });
    expect(innerText(claude)).toBe("CL");
    expect(innerText(claude)).not.toBe("Claude");
    expect(innerText(mark({ toolConfigKey: "codex" }))).toBe("CX");
    // Two letters is the whole design: the word does not fit beside a branch
    // name, which is the only line with any room.
    for (const tool of ["claude", "codex", "aider", "shell", "service", "anything-else"]) {
      expect(innerText(mark({ toolConfigKey: tool })), tool).toHaveLength(2);
    }
  });

  it("says the real word where there is room for it", () => {
    // The mark is two letters; a screen reader gets the runtime's name.
    expect(mark({ toolConfigKey: "codex" }).props.accessibilityLabel).toBe("Codex");
    expect(mark({ toolConfigKey: "claude" }).props.accessibilityLabel).toBe("Claude");
    expect(mark({}).props.accessibilityLabel).toBe("Agent");
  });

  it("occupies the space it claims", () => {
    const style = mark({ toolConfigKey: "claude" }).props.style ?? {};
    expect(style.minWidth).toBe(RUNTIME_BRAND_MARK_WIDTH);
    expect(style.minHeight).toBeGreaterThan(0);
    // A mark nothing can see is the same as no mark, and a source gate reads
    // the same either way.
    expect(style.opacity, "an invisible mark is not a mark").toBeUndefined();
    expect(style.display).toBeUndefined();
    expect(style.height, "fixed height clips the 9pt line on Android").toBeUndefined();
    expect(style.width).toBeUndefined();
  });

  it("wears the runtime's own colour, on both the ground and the edge", () => {
    for (const tool of ["claude", "codex", "aider", "shell"]) {
      const brand = runtimeBrandForTool(tool);
      const element = mark({ toolConfigKey: tool });
      const style = element.props.style ?? {};
      expect(style.backgroundColor, tool).toBe(brand.background);
      // The edge matters: `headerTone` is a hashed hue, so the worktree rule
      // beside this can be the same colour as the mark's ground.
      expect(style.borderColor, tool).toBe(brand.color);
      expect((element.props.children as Element).props.style?.color, tool).toBe(brand.color);
    }
  });

  it("takes the runtime from the agent, not from one field of it", () => {
    // `agentToolName`'s precedence: the config key wins over the command.
    expect(innerText(mark({ toolConfigKey: "codex", command: "claude --continue" }))).toBe("CX");
    expect(innerText(mark({ command: "claude --continue" }))).toBe("CL");
    expect(innerText(mark({ label: "aider-7x2k9" }))).toBe("AI");
    expect(innerText(mark({ command: "zsh -l" }))).toBe("SH");
  });
});
