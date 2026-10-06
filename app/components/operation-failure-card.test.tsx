import React, { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  View: "View",
  Platform: { OS: "web", select: (spec: Record<string, unknown>) => spec.web },
  ScrollView: "ScrollView",
}));

vi.mock("@/components/ui/text", () => ({
  Text: "Text",
}));

vi.mock("@/components/ui/card", () => ({
  Card: "Card",
}));

const clearOperationFailures = vi.fn(async (..._args: unknown[]) => ({ ok: true, cleared: 2 }));
vi.mock("@/lib/api", () => ({
  clearOperationFailures: (...args: unknown[]) => clearOperationFailures(...args),
}));

import { renderToStaticMarkup } from "react-dom/server";
import {
  OperationFailureCard,
  OperationFailureCardView,
  dismissOperationFailures,
  runOperationFailureDismiss,
  useDismissIo,
} from "@/components/operation-failure-card";
import type { ServiceEndpoint } from "@/lib/daemon-url";

interface HostNode {
  type: unknown;
  props: Record<string, unknown>;
  children: HostNode[];
}

function renderNode(node: ReactNode): HostNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap(renderNode);
  if (!React.isValidElement(node)) return [];
  if (node.type === React.Fragment) {
    return renderNode((node.props as { children?: ReactNode }).children);
  }
  if (typeof node.type === "function") {
    return renderNode((node.type as (props: unknown) => ReactNode)(node.props));
  }
  const props = node.props as Record<string, unknown> & { children?: ReactNode };
  return [{ type: node.type, props, children: renderNode(props.children) }];
}

function findNodes(roots: HostNode[], match: (node: HostNode) => boolean): HostNode[] {
  return roots.flatMap((node) => [
    ...(match(node) ? [node] : []),
    ...findNodes(node.children, match),
  ]);
}

function allText(roots: HostNode[]): string {
  return roots
    .flatMap((node) => [
      typeof node.props.children === "string" ? node.props.children : "",
      allText(node.children),
    ])
    .join(" ");
}

function dismissControls(roots: HostNode[]): HostNode[] {
  return findNodes(roots, (node) => node.props.accessibilityLabel === "Dismiss failed operations");
}

const summary = { title: "Failed to graveyard worktree fix-chat", detail: "worktree is busy" };
const endpoint: ServiceEndpoint = { host: "127.0.0.1", port: 43190 };

describe("the failed-operations card", () => {
  beforeEach(() => {
    clearOperationFailures.mockClear();
  });

  /// The card still says WHAT failed. An adversarial review of PR 406 pointed
  /// out that every assertion here was about the dismiss, so the card could
  /// stop naming the failed operation entirely and nothing would notice.
  it("names what failed", () => {
    const tree = renderNode(
      <OperationFailureCardView
        summary={summary}
        error={null}
        dismissing={false}
        onDismiss={() => {}}
        endpoint={endpoint}
      />,
    );
    const text = allText(tree);
    expect(text).toContain("Failed to graveyard worktree fix-chat");
    expect(text).toContain("worktree is busy");
    // The tone, as a reader sees it. `tone` is a prop of `PageStateCard`,
    // which this harness invokes, so the only trace left on a host node is the
    // class the card resolved it to.
    const [card] = findNodes(tree, (node) => String(node.props.className ?? "").includes("amber"));
    expect(card, "a failure card that does not read as a failure").toBeDefined();
  });

  /// The app shipped with no dismiss at all -- `clearOperationFailures` existed
  /// in `api.ts` and had exactly one caller, its own unit test.
  ///
  /// `Button` is a `forwardRef`, which this harness cannot invoke, so what is
  /// asserted is what the card HANDS the control. That `Button` forwards
  /// `onPress` and `label` to a `Pressable` is its own contract, not this one.
  it("offers a dismiss, and pressing it runs the handler", () => {
    const onDismiss = vi.fn();
    const tree = renderNode(
      <OperationFailureCardView
        summary={summary}
        error={null}
        dismissing={false}
        onDismiss={onDismiss}
        endpoint={endpoint}
      />,
    );
    const [control] = dismissControls(tree);
    expect(control, "no dismiss control on the card").toBeDefined();
    expect(control.props.label).toBe("Dismiss");
    expect(control.props.disabled).toBe(false);
    (control.props.onPress as () => void)();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  /// A press in flight says so and refuses a second one, because clearing is a
  /// round trip to a host and a button that looks idle invites the second tap.
  it("says it is working and takes no second press while it is", () => {
    const tree = renderNode(
      <OperationFailureCardView
        summary={summary}
        error={null}
        dismissing
        onDismiss={() => {}}
        endpoint={endpoint}
      />,
    );
    const [control] = dismissControls(tree);
    expect(control.props.label).toBe("Dismissing...");
    expect(control.props.disabled).toBe(true);
  });

  /// The inverse. Without it the assertion above passes on a card that renders
  /// a dismiss whatever the state of the host, which is the lie this card made
  /// for a different reason already: a control for a service nobody can reach.
  it("offers no dismiss when there is no host to ask", () => {
    const tree = renderNode(
      <OperationFailureCardView
        summary={summary}
        error={null}
        dismissing={false}
        onDismiss={() => {}}
        endpoint={null}
      />,
    );
    expect(dismissControls(tree)).toHaveLength(0);
  });

  /// A dismiss that fails says so. Clearing is a request to a host that may be
  /// gone, and a card that stayed put with no word is the one outcome worse
  /// than the card itself.
  it("says so when the dismiss could not be delivered", () => {
    const tree = renderNode(
      <OperationFailureCardView
        summary={summary}
        error="Could not dismiss: connection refused"
        dismissing={false}
        onDismiss={() => {}}
        endpoint={endpoint}
      />,
    );
    expect(allText(tree)).toContain("Could not dismiss: connection refused");
  });

  /// At the seam a person actually reads. Round 4 of this PR's review caught
  /// the previous version asserting on the string handed to `setError` while
  /// the view prefixed every error with "Could not dismiss:" regardless -- so a
  /// refresh that failed after a clear that worked drew "Could not dismiss:
  /// Dismissed, but the view did not refresh", contradicting itself and blaming
  /// the half that worked.
  it("draws an error exactly as it was framed, adding no blame of its own", () => {
    const tree = renderNode(
      <OperationFailureCardView
        summary={summary}
        error="Dismissed, but the view did not refresh: atom store is gone"
        dismissing={false}
        onDismiss={() => {}}
        endpoint={endpoint}
      />,
    );
    const text = allText(tree);
    expect(text).toContain("Dismissed, but the view did not refresh");
    expect(text).not.toContain("Could not dismiss");
  });

  /// The SHELL, rendered for real, because the assembly is the product change.
  ///
  /// Round 5 of this PR's review found that nothing instantiated it: the view
  /// and the sequence were tested, `WorktreeDashboard.test.tsx` mocks the shell
  /// away, and so `endpoint={null}` at either call site removed the whole
  /// feature with the suite green. I had declared this seam unreachable on the
  /// grounds that the harness cannot run hooks; `react-dom/server` is already a
  /// dependency and runs `useState`, `useRef` and `useSetAtom` perfectly well.
  /// It renders but does not press, which is what `dismissIo` is for.
  describe("the shell, assembled", () => {
    it("renders a dismiss when there is a host", () => {
      const html = renderToStaticMarkup(
        <OperationFailureCard summary={summary} endpoint={endpoint} token="tok" />,
      );
      expect(html).toContain("Dismiss failed operations");
      expect(html).toContain(summary.title);
    });

    it("renders none when there is not", () => {
      const html = renderToStaticMarkup(
        <OperationFailureCard summary={summary} endpoint={null} token="tok" />,
      );
      expect(html).not.toContain("Dismiss failed operations");
      // Still says what failed, which is the half that does not need a host.
      expect(html).toContain(summary.title);
    });
  });

  /// The mapping `renderToStaticMarkup` cannot reach. Wiring `inFlight` to the
  /// `dismissing` state instead of the ref is the mutation that brought the
  /// double-POST back with everything else green.
  describe("the callbacks the shell hands over", () => {
    /// The hook itself, run under SSR, because the guard lives inside it now
    /// and the point is that no caller supplies it.
    function capture(setDismissing: () => void, setError: () => void, refresh: () => void) {
      let captured: ReturnType<typeof useDismissIo> | null = null;
      function Probe() {
        captured = useDismissIo(setDismissing, setError, refresh);
        return null;
      }
      renderToStaticMarkup(<Probe />);
      if (captured === null) throw new Error("the hook did not run");
      return captured as ReturnType<typeof useDismissIo>;
    }

    it("keeps the guard on a ref, not on a render-scoped flag", () => {
      const setDismissing = vi.fn();
      const io = capture(setDismissing, vi.fn(), vi.fn());
      expect(io.inFlight()).toBe(false);
      io.setInFlight(true);
      expect(io.inFlight(), "the next press in the same frame has to see it").toBe(true);
      expect(setDismissing, "the guard is not the render flag").not.toHaveBeenCalled();
    });

    it("keeps the render flag and the error apart", () => {
      const setDismissing = vi.fn();
      const setError = vi.fn();
      const refresh = vi.fn();
      const io = capture(setDismissing, setError, refresh);
      io.setDismissing(true);
      io.setError("boom");
      io.refresh();
      expect(setDismissing).toHaveBeenCalledWith(true);
      expect(setError).toHaveBeenCalledWith("boom");
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  /// The body of the request, which is the whole reach of the key. An empty
  /// match clears the ledger AND the `operationFailure` stamped on a worktree
  /// row -- and the row's copy has no expiry, so a named match would leave the
  /// row red forever with the card gone.
  it("asks the service to clear everything, not one named thing", async () => {
    await expect(dismissOperationFailures(endpoint, "tok")).resolves.toBeNull();
    expect(clearOperationFailures).toHaveBeenCalledWith(endpoint, {}, { token: "tok" });
  });

  /// The sequence the button runs, which no rendered test can reach: this
  /// harness has no DOM and calls components as functions, so hooks never run.
  /// With it inlined in the component, deleting the in-flight guard, never
  /// clearing it, dropping the refresh or swallowing the error all survived the
  /// whole suite.
  describe("the sequence behind the press", () => {
    function io() {
      let flight = false;
      return {
        inFlight: () => flight,
        setInFlight: vi.fn((value: boolean) => {
          flight = value;
        }),
        setDismissing: vi.fn(),
        setError: vi.fn(),
        refresh: vi.fn(),
      };
    }

    /// And a failed dismiss keeps its own frame, which the view no longer adds.
    it("frames a failed dismiss as a failed dismiss", async () => {
      clearOperationFailures.mockImplementationOnce(async () => {
        throw new Error("Failed to fetch");
      });
      const sink = io();
      await runOperationFailureDismiss(endpoint, "tok", sink);
      expect(sink.setError).toHaveBeenCalledWith(
        expect.stringContaining("Could not dismiss: Failed to fetch"),
      );
    });

    it("clears, refreshes, and leaves nothing in flight", async () => {
      const sink = io();
      await runOperationFailureDismiss(endpoint, "tok", sink);
      expect(clearOperationFailures).toHaveBeenCalledWith(endpoint, {}, { token: "tok" });
      expect(sink.refresh).toHaveBeenCalledTimes(1);
      expect(sink.setError).toHaveBeenCalledWith(null);
      expect(sink.setDismissing.mock.calls).toEqual([[true], [false]]);
      expect(sink.inFlight()).toBe(false);
    });

    /// Two taps inside one frame. `disabled` only reaches the control on the
    /// next render, so the guard is the only thing standing between one press
    /// and two requests.
    it("takes one request from two presses in the same frame", async () => {
      const sink = io();
      await Promise.all([
        runOperationFailureDismiss(endpoint, "tok", sink),
        runOperationFailureDismiss(endpoint, "tok", sink),
      ]);
      expect(clearOperationFailures).toHaveBeenCalledTimes(1);
    });

    /// And the press after that one still works, which is the half that a
    /// guard set but never cleared would break -- silently, and forever.
    it("still works on the next press", async () => {
      const sink = io();
      await runOperationFailureDismiss(endpoint, "tok", sink);
      await runOperationFailureDismiss(endpoint, "tok", sink);
      expect(clearOperationFailures).toHaveBeenCalledTimes(2);
    });

    it("reports a failure and does not refresh", async () => {
      clearOperationFailures.mockImplementationOnce(async () => {
        throw new Error("Failed to fetch");
      });
      const sink = io();
      await runOperationFailureDismiss(endpoint, "tok", sink);
      expect(sink.setError).toHaveBeenCalledWith(expect.stringContaining("Failed to fetch"));
      expect(sink.refresh).not.toHaveBeenCalled();
      expect(sink.inFlight()).toBe(false);
    });

    /// A refresh that throws is not a dismiss that failed. The clear already
    /// happened; saying "Could not dismiss" would be the wrapper lying about
    /// which half went wrong.
    it("does not report a refresh failure as a failed dismiss", async () => {
      const sink = io();
      sink.refresh.mockImplementationOnce(() => {
        throw new Error("atom store is gone");
      });
      await runOperationFailureDismiss(endpoint, "tok", sink);
      // Named as the refresh, not as the dismiss, and on screen rather than an
      // unhandled rejection out of `onPress`.
      expect(sink.setError).toHaveBeenCalledWith(
        expect.stringContaining("Dismissed, but the view did not refresh"),
      );
      expect(sink.setError).not.toHaveBeenCalledWith(expect.stringContaining("Could not dismiss"));
      // And what the card DRAWS from it, which is the seam that matters: the
      // string reaching `setError` was already right, and the card still wrote
      // "Could not dismiss" in front of it.
      const framed = sink.setError.mock.calls
        .flat()
        .filter((value): value is string => typeof value === "string");
      const drawn = renderNode(
        <OperationFailureCardView
          summary={summary}
          error={framed[framed.length - 1]}
          dismissing={false}
          onDismiss={() => {}}
          endpoint={endpoint}
        />,
      );
      expect(allText(drawn)).not.toContain("Could not dismiss");
      // And the button is usable again, which a throw past the reset would have
      // left stuck at "Dismissing..." forever.
      expect(sink.inFlight()).toBe(false);
      expect(sink.setDismissing).toHaveBeenLastCalledWith(false);
    });

    it("asks nothing of a host that is not there", async () => {
      const sink = io();
      await runOperationFailureDismiss(null, "tok", sink);
      expect(clearOperationFailures).not.toHaveBeenCalled();
      expect(sink.setDismissing).not.toHaveBeenCalled();
    });
  });

  /// The reason this path does not run errors through `isTransientRequestError`
  /// first: that predicate matches "failed to fetch", so an unreachable host --
  /// the one answer a person pressing Dismiss has to be told -- would have been
  /// filed as a blip and the card would have sat there unchanged.
  it("reports an unreachable host rather than filing it as a blip", async () => {
    clearOperationFailures.mockImplementationOnce(async () => {
      throw new Error("Failed to fetch (http://127.0.0.1:43190/operation-failures/clear)");
    });
    await expect(dismissOperationFailures(endpoint, null)).resolves.toContain("Failed to fetch");
  });
});
