import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import type { LivePaneInputDelivery } from "../../src/project-api-contract";
import { composerFooterState } from "@/lib/composer-footer";
import {
  formatLivePaneInputDeliveryNotice,
  formatLivePaneInputResponseRefusal,
  livePaneInputDeliveryOutcome,
  sendDeliveryStateAfterResponse,
} from "@/lib/input-delivery";
import { AGENT_OUTPUT_VIEW_MODES } from "@/stores/settings";

const fixture = JSON.parse(
  readFileSync(
    join(__dirname, "../../testdata/contracts/v1/input-delivery-verification/surfaces.json"),
    "utf8",
  ),
) as {
  prompt: string;
  state: string;
  cases: Array<{
    name: string;
    delivery: LivePaneInputDelivery;
    expectedOutcome: string;
    expectedNotice: string | null;
  }>;
};
const chat = source("../components/screens/AgentChatScreen.tsx");
const monitor = source("../app/(main)/monitor.tsx");
const multipartPrompt = `${fixture.prompt}\n${"a".repeat(4577)}\n${"b".repeat(3941)}`;

function source(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(join(__dirname, path), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function variable(file: ts.SourceFile, name: string): ts.Expression {
  let result: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name)
      result = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!result) throw new Error(`Missing production variable ${name}`);
  return result;
}

// Execute production callbacks with their external dependencies replaced; Expo has no test renderer.
function evaluate<T>(
  expression: ts.Node,
  file: ts.SourceFile,
  bindings: Record<string, unknown>,
): T {
  const script = ts.transpileModule(
    `function evaluate() { return (${expression.getText(file)}); }`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
    },
  ).outputText;
  return new Function(...Object.keys(bindings), `${script}; return evaluate();`)(
    ...Object.values(bindings),
  );
}

function callback(file: ts.SourceFile, name: string, bindings: Record<string, unknown>) {
  const call = variable(file, name);
  if (!ts.isCallExpression(call)) throw new Error(`${name} must be a hook callback`);
  return evaluate<(...args: unknown[]) => Promise<void>>(call.arguments[0], file, bindings);
}

function chatBindings(delivery: LivePaneInputDelivery) {
  return {
    normalizeComposerDraft: (text: string) => text,
    readComposerDraft: () => multipartPrompt,
    jotaiStore: {},
    composerDraftKey: "lane",
    pendingAttachments: [],
    serviceEndpoint: {},
    sessionId: "lane",
    sessionKey: "lane",
    session: { state: fixture.state },
    ownerShareStatusPending: false,
    sendBusyRef: { current: false },
    composerAwaitingAck: false,
    firstOversizedAttachment: () => null,
    sendOperationIdRef: { current: 0 },
    activeComposerDraftKeyRef: { current: "lane" },
    clearLocalInterruptHold: vi.fn(),
    agentKey: "lane",
    userMessageCountRef: { current: 0 },
    parsedMessageCountRef: { current: 0 },
    parsedUserMessageCountRef: { current: 0 },
    chatViewportRef: { current: null },
    terminalViewportRef: { current: null },
    setSendBusy: vi.fn(),
    setSendError: vi.fn(),
    setSendWarning: vi.fn(),
    setHeldDelivery: vi.fn(),
    token: null,
    sharedChatActor: null,
    sendLivePaneInput: vi.fn(async () => ({
      ok: true,
      accepted: true,
      sessionId: "lane",
      delivery,
    })),
    formatLivePaneInputResponseRefusal,
    sendDeliveryStateAfterResponse,
    buildAcceptedComposerMessage: vi.fn(() => ({})),
    releasePendingAttachmentPreviews: vi.fn(),
    writeComposerDraft: vi.fn(),
    composerDraftTextRef: { current: multipartPrompt },
    setPendingAttachments: vi.fn(),
    setPendingComposerAck: vi.fn(),
    composerDraftsByKey: new Map(),
    refreshOutputSnapshot: vi.fn(async () => {}),
    setAcceptedComposerMessages: vi.fn(),
    isTransientRequestError: () => false,
    formatComposerSendFailure: String,
  };
}

describe("submission receipts stay consistent across app surfaces", () => {
  it.each(fixture.cases)("renders the server's $name outcome without rewording it", (entry) => {
    expect(livePaneInputDeliveryOutcome(entry.delivery)).toBe(entry.expectedOutcome);
    expect(formatLivePaneInputDeliveryNotice(entry.delivery)).toBe(entry.expectedNotice);
  });

  it("keeps a ready lane's two large unsent blocks out of confirmed chat delivery", async () => {
    expect(fixture.state).toBe("ready");
    expect(multipartPrompt.length).toBeGreaterThan(8500);
    const entry = fixture.cases.find((entry) => entry.expectedOutcome === "unverified")!;
    expect(entry).toBeDefined();
    const bindings = chatBindings(entry.delivery);
    await callback(chat, "handleSendMessage", bindings)();
    expect(bindings.sendLivePaneInput).toHaveBeenCalledWith(
      {},
      "lane",
      multipartPrompt,
      expect.anything(),
    );
    expect(bindings.setSendWarning).toHaveBeenLastCalledWith(entry.expectedNotice);
    expect(bindings.setSendError).toHaveBeenLastCalledWith(null);
    expect(bindings.setHeldDelivery).toHaveBeenLastCalledWith(null);
    expect(bindings.setAcceptedComposerMessages).not.toHaveBeenCalled();
    expect(bindings.composerDraftTextRef.current).toBe("");

    for (const mode of AGENT_OUTPUT_VIEW_MODES) {
      const footer = evaluate(variable(chat, "composerFooterStateValue"), chat, {
        composerFooterState,
        activityLabel: "Ready",
        activityLabelShimmer: false,
        composerSendPendingEcho: false,
        sendError: null,
        heldDeliveryNotice: null,
        sendWarning: entry.expectedNotice,
        agentOutputViewMode: mode,
        canUseOwnerControls: true,
        sendBusy: false,
        composerAwaitingAck: false,
        chatSplitWidth: 1400,
      });
      expect(footer).toEqual({ kind: "warning", text: entry.expectedNotice });
      const view = chat.statements.find(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === "ComposerFooterContentView",
      );
      expect(view).toBeDefined();
      const render = evaluate<(props: { content: unknown }) => unknown>(view!, chat, {
        React: {
          createElement: (component: string, props: unknown, ...children: unknown[]) => ({
            component,
            props,
            children,
          }),
        },
        View: "View",
        Text: "Text",
        CircleAlert: "CircleAlert",
      });
      expect(JSON.stringify(render({ content: footer }))).toContain(entry.expectedNotice);
    }
  });

  it("still renders a verified send through the accepted-message path", async () => {
    const bindings = chatBindings({ state: "delivered", verified: true });
    await callback(chat, "handleSendMessage", bindings)();
    expect(bindings.setAcceptedComposerMessages).toHaveBeenCalledOnce();
    expect(bindings.setSendWarning).toHaveBeenLastCalledWith(null);
  });

  it.each(fixture.cases)("Monitor preserves $name instead of assuming delivery", async (entry) => {
    for (const kind of ["project-agent", "shared-chat"]) {
      const bindings = {
        selectedTarget: {
          id: "target",
          kind,
          endpoint: {},
          sessionId: "lane",
          ownerUserId: "owner",
        },
        getToken: async () => null,
        user: null,
        userId: "user",
        settings: {},
        formatMonitorSampleText: () => multipartPrompt,
        sendLivePaneInput: vi.fn(async () => ({
          ok: true,
          accepted: true,
          sessionId: "lane",
          delivery: entry.delivery,
        })),
        resolveSharedChatActor: vi.fn(),
        formatLivePaneInputResponseRefusal,
        sendDeliveryStateAfterResponse,
        setDeliveryNotice: vi.fn(),
        setLastDelivery: vi.fn(),
        setDeliveryTargetId: vi.fn(),
      };
      const send = callback(monitor, "handleSampleCaptured", bindings);
      if (entry.expectedOutcome === "failed") {
        await expect(send({})).rejects.toThrow(entry.expectedNotice!);
        expect(bindings.setLastDelivery).not.toHaveBeenCalled();
      } else {
        await send({});
        expect(bindings.sendLivePaneInput).toHaveBeenCalledOnce();
        expect(bindings.setDeliveryNotice).toHaveBeenLastCalledWith(entry.expectedNotice);
        if (entry.expectedOutcome === "delivered") {
          expect(bindings.setLastDelivery).toHaveBeenCalledWith(expect.any(String));
        } else {
          expect(bindings.setLastDelivery).toHaveBeenLastCalledWith(null);
          const hint = evaluate(variable(monitor, "panelDeliveryHint"), monitor, {
            deliveryEnabled: true,
            selectedTarget: { id: "target" },
            deliveryTargetId: "target",
            deliveryNotice: entry.expectedNotice,
            lastDelivery: "previous confirmed time",
            deliveryHint: null,
          });
          expect(hint).toBe(entry.expectedNotice);
          const otherTargetHint = evaluate(variable(monitor, "panelDeliveryHint"), monitor, {
            deliveryEnabled: true,
            selectedTarget: { id: "other-target" },
            deliveryTargetId: "target",
            deliveryNotice: entry.expectedNotice,
            lastDelivery: "previous confirmed time",
            deliveryHint: null,
          });
          expect(otherTargetHint).toBeNull();
        }
      }
    }
  });
});
