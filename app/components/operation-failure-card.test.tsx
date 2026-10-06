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

import {
  OperationFailureCardView,
  dismissOperationFailures,
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
      <OperationFailureCardView summary={summary} error={null} dismissing onDismiss={() => {}} />,
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
        onDismiss={null}
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
        error="connection refused"
        dismissing={false}
        onDismiss={() => {}}
      />,
    );
    expect(allText(tree)).toContain("Could not dismiss: connection refused");
  });

  /// The body of the request, which is the whole reach of the key. An empty
  /// match clears the ledger AND the `operationFailure` stamped on a worktree
  /// row -- and the row's copy has no expiry, so a named match would leave the
  /// row red forever with the card gone.
  it("asks the service to clear everything, not one named thing", async () => {
    const sink = { cleared: vi.fn(), failed: vi.fn() };
    await dismissOperationFailures(endpoint, "tok", sink);
    expect(clearOperationFailures).toHaveBeenCalledWith(endpoint, {}, { token: "tok" });
    expect(sink.cleared).toHaveBeenCalledTimes(1);
    expect(sink.failed).not.toHaveBeenCalled();
  });

  /// The reason this path does not run errors through `isTransientRequestError`
  /// first: that predicate matches "failed to fetch", so an unreachable host --
  /// the one answer a person pressing Dismiss has to be told -- would have been
  /// filed as a blip and the card would have sat there unchanged.
  it("reports an unreachable host rather than filing it as a blip", async () => {
    clearOperationFailures.mockImplementationOnce(async () => {
      throw new Error("Failed to fetch (http://127.0.0.1:43190/operation-failures/clear)");
    });
    const sink = { cleared: vi.fn(), failed: vi.fn() };
    await dismissOperationFailures(endpoint, null, sink);
    expect(sink.cleared).not.toHaveBeenCalled();
    expect(sink.failed).toHaveBeenCalledWith(expect.stringContaining("Failed to fetch"));
  });
});
