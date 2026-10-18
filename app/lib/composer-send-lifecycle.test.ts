import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createStore } from "jotai";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { chatComposerDraftFamily, chatComposerSendOperationFamily } from "@/stores/ui";
import {
  formatComposerSendFailure,
  normalizeComposerDraft,
  userMessageAcknowledgesComposerSend,
  type PendingComposerAckLike,
} from "@/lib/composer-protocol";
import {
  formatLivePaneInputResponseRefusal,
  formatPostActionTranscriptRefreshResult,
  sendDeliveryStateAfterResponse,
} from "@/lib/input-delivery";
import { attachmentTooLargeMessage, firstOversizedAttachment } from "@/lib/attachment-limits";
import { isTransientRequestError } from "@/lib/request-errors";

type Attachment = {
  id: string;
  kind: string;
  filename: string;
  mimeType: string;
  uploadedAttachmentId?: string;
};
type Ack = PendingComposerAckLike;
type ComposerRefs = {
  sendBusyRef: { current: boolean };
  sendOperationIdRef: { current: number };
  activeComposerDraftKeyRef: { current: string | null };
  composerDraftTextRef: { current: string };
  pendingAttachmentsRef: { current: Attachment[] };
};
const screenPath = join(__dirname, "../components/screens/AgentChatScreen.tsx");

function screenAst() {
  return ts.createSourceFile(
    screenPath,
    readFileSync(screenPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function exactlyOne<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T {
  const matches: T[] = [];
  function visit(node: ts.Node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  expect(matches, "screen declaration must remain uniquely executable").toHaveLength(1);
  return matches[0]!;
}

function declaration(root: ts.Node, name: string) {
  return exactlyOne(
    root,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && node.name.getText() === name,
  );
}

function compile<T>(code: string, context: Record<string, unknown>): T {
  const javascript = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(context), `${javascript}\nreturn callback;`)(
    ...Object.values(context),
  ) as T;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const attachment = (id = "one"): Attachment => ({
  id,
  kind: "image",
  filename: `${id}.png`,
  mimeType: "image/png",
});
const confirmed = [{ role: "user", parts: [{ type: "text", text: "original prompt" }] }];

function runtime() {
  return {
    store: createStore(),
    drafts: new Map(),
    seeded: new Set<string>(),
    sendLivePaneInput: vi.fn(async (..._args: unknown[]) => ({ accepted: true })),
    uploadAttachment: vi.fn(async (..._args: unknown[]) => ({
      attachment: { id: "uploaded-one" },
    })),
  };
}

function harness(
  initialAttachments: Attachment[] = [],
  shared = runtime(),
  key = "lifecycle:session",
  reusedRefs?: ComposerRefs,
) {
  const source = screenAst();
  const { store, drafts, sendLivePaneInput, uploadAttachment } = shared;
  const draftAtom = chatComposerDraftFamily(key);
  const composerSendOperationAtom = chatComposerSendOperationFamily(key);
  if (!shared.seeded.has(key)) {
    store.set(draftAtom, "original prompt");
    shared.seeded.add(key);
  }
  const state = {
    error: null as string | null,
    ack: null as Ack | null,
    attachments: initialAttachments,
    accepted: [] as unknown[],
  };
  const sendBusyRef = reusedRefs?.sendBusyRef ?? { current: false };
  const releasePickedAttachment = vi.fn();
  const refs = reusedRefs ?? {
    sendBusyRef,
    sendOperationIdRef: { current: 0 },
    activeComposerDraftKeyRef: { current: key as string | null },
    composerDraftTextRef: { current: store.get(draftAtom) },
    pendingAttachmentsRef: { current: state.attachments },
  };
  const clearLocalInterruptHold = vi.fn();
  const base = {
    chatComposerDraftFamily,
    composerDraftsByKey: drafts,
    formatComposerSendFailure,
    normalizeComposerDraft,
    userMessageAcknowledgesComposerSend,
    formatLivePaneInputResponseRefusal,
    formatPostActionTranscriptRefreshResult,
    sendDeliveryStateAfterResponse,
    attachmentTooLargeMessage,
    firstOversizedAttachment,
    isTransientRequestError,
    releasePickedAttachment,
  };
  const helperNames = [
    "readComposerDraft",
    "writeComposerDraft",
    "rememberComposerDraft",
    "releasePendingAttachmentPreviews",
    "attachmentHistoryPartsFromUploads",
    "buildAcceptedComposerMessage",
  ];
  const helpers = helperNames
    .map((name) =>
      exactlyOne(
        source,
        (node): node is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(node) && node.name?.text === name,
      ).getText(),
    )
    .join("\n");
  function context() {
    return {
      ...base,
      jotaiStore: store,
      composerDraftKey: key,
      composerSendOperationAtom,
      ...refs,
      serviceEndpoint: "http://project.test",
      sessionId: "session",
      session: { id: "session" },
      sessionKey: "session",
      agentKey: "project:session",
      ownerShareStatusPending: false,
      sendBusyRef,
      userMessageCountRef: { current: 0 },
      parsedMessageCountRef: { current: 0 },
      parsedUserMessageCountRef: { current: 0 },
      pendingAttachments: state.attachments,
      pendingComposerAck: state.ack,
      clearLocalInterruptHold,
      chatViewportRef: { current: { showNewest: vi.fn() } },
      terminalViewportRef: { current: { showNewest: vi.fn() } },
      setSendError: (value: string | null) => {
        state.error = value;
      },
      setHeldDelivery: vi.fn(),
      setPendingComposerAck: (value: Ack | null) => {
        state.ack = value;
      },
      setPendingAttachments: (value: Attachment[]) => {
        state.attachments = value;
        refs.pendingAttachmentsRef.current = value;
      },
      setAcceptedComposerMessages: (update: unknown[] | ((old: unknown[]) => unknown[])) => {
        state.accepted = typeof update === "function" ? update(state.accepted) : update;
      },
      pickedAttachmentDataBase64: vi.fn(async () => "aW1hZ2U="),
      uploadAttachment,
      sendLivePaneInput,
      refreshOutputSnapshot: vi.fn(async () => {}),
      sharedChatActor: null,
      token: undefined,
      composerInputRef: { current: null },
      requestAnimationFrame: (callback: () => void) => callback(),
    };
  }
  const sendInitializer = declaration(source, "handleSendMessage").initializer;
  expect(sendInitializer && ts.isCallExpression(sendInitializer)).toBe(true);
  const arrow = (sendInitializer as ts.CallExpression).arguments[0]!;
  expect(ts.isArrowFunction(arrow)).toBe(true);
  const callback = compile<() => Promise<void>>(
    `${helpers}\nconst callback = ${arrow.getText()};`,
    context(),
  );
  function effectUsing(...identifiers: string[]) {
    return exactlyOne(source, (node): node is ts.CallExpression => {
      if (!ts.isCallExpression(node) || node.expression.getText() !== "useEffect") return false;
      const callback = node.arguments[0];
      if (!callback || !ts.isArrowFunction(callback)) return false;
      const names = new Set<string>();
      function visit(child: ts.Node) {
        if (ts.isIdentifier(child)) names.add(child.text);
        ts.forEachChild(child, visit);
      }
      visit(callback);
      return identifiers.every((name) => names.has(name));
    });
  }
  function effectCallback(effect: ts.CallExpression) {
    return compile<() => void | (() => void)>(
      `${helpers}\nconst callback = ${effect.arguments[0]!.getText()};`,
      context(),
    );
  }
  function acknowledge(messages = confirmed) {
    const effect = effectUsing("pendingComposerAck", "composerSendAcknowledged");
    const acknowledged = declaration(source, "composerSendAcknowledged").initializer!;
    compile<() => void>(
      `${helpers}\nconst composerSendAcknowledged = ${acknowledged.getText()};\nconst callback = ${effect.arguments[0]!.getText()};`,
      { ...context(), allMessages: messages },
    )();
  }
  return {
    reset: () =>
      effectCallback(
        effectUsing("previousKey", "activeComposerDraftKeyRef", "setPendingComposerAck"),
      )(),
    unmount: () => {
      const cleanup = effectCallback(
        effectUsing("activeKey", "rememberComposerDraft", "pendingAttachmentsRef"),
      )();
      expect(cleanup).toBeTypeOf("function");
      (cleanup as () => void)();
    },
    uiBusy: () =>
      compile<() => boolean>(
        `const callback = () => (${declaration(source, "sendBusy").initializer!.getText()});`,
        { ...context(), useAtomValue: (atom: typeof composerSendOperationAtom) => store.get(atom) },
      )(),
    shared,
    refs,
    composerSendOperationAtom,
    clearLocalInterruptHold,
    state,
    send: callback,
    sendBusyRef,
    sendLivePaneInput,
    uploadAttachment,
    releasePickedAttachment,
    acknowledge,
    draft: () => store.get(draftAtom),
    setDraft: (text: string) => store.set(draftAtom, text),
    drafts,
  };
}

async function transientFailure() {
  const h = harness([attachment()]);
  h.sendLivePaneInput.mockRejectedValueOnce(new Error("network request failed"));
  await h.send();
  return h;
}

describe("the screen's composer send lifecycle without a renderer", () => {
  it("blocks a second same-render send while transport is pending", async () => {
    const h = harness();
    const response = deferred<{ accepted: boolean }>();
    h.sendLivePaneInput.mockImplementation(() => response.promise);
    const first = h.send();
    const second = h.send();
    try {
      expect(h.sendLivePaneInput).toHaveBeenCalledTimes(1);
      expect(h.sendBusyRef.current).toBe(true);
      expect(h.uiBusy()).toBe(true);
    } finally {
      response.resolve({ accepted: true });
      await Promise.all([first, second]);
    }
    expect(h.sendBusyRef.current).toBe(false);
  });

  it("blocks a second same-render send while an attachment upload is pending", async () => {
    const h = harness([attachment()]);
    const uploaded = deferred<{ attachment: { id: string } }>();
    h.uploadAttachment.mockImplementation(() => uploaded.promise);
    const first = h.send();
    await vi.waitFor(() => expect(h.uploadAttachment).toHaveBeenCalledTimes(1));
    const second = h.send();
    try {
      expect(h.uploadAttachment).toHaveBeenCalledTimes(1);
      expect(h.sendLivePaneInput).not.toHaveBeenCalled();
    } finally {
      uploaded.resolve({ attachment: { id: "uploaded-one" } });
      await Promise.all([first, second]);
    }
    expect(h.sendLivePaneInput).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure"])(
    "allows the next send after %s releases the guard",
    async (outcome) => {
      const h = harness();
      if (outcome === "failure") h.sendLivePaneInput.mockRejectedValueOnce(new Error("denied"));
      await h.send();
      expect(h.sendBusyRef.current).toBe(false);
      expect(h.uiBusy()).toBe(false);
      h.setDraft("next prompt");
      await h.send();
      expect(h.sendLivePaneInput).toHaveBeenCalledTimes(2);
      expect(h.sendLivePaneInput.mock.calls[1]?.[2]).toBe("next prompt");
      expect(h.draft()).toBe("");
    },
  );

  it("retains the transient send's draft, uploaded attachments, and live pending ack", async () => {
    const h = await transientFailure();
    expect(h.draft()).toBe("original prompt");
    expect(h.state.attachments).toEqual([
      { ...attachment(), uploadedAttachmentId: "uploaded-one" },
    ]);
    expect(h.state.ack).toMatchObject({
      text: "original prompt",
      attachmentIds: ["uploaded-one"],
      attachmentFilenames: ["one.png"],
      baselineUserMessageCount: 0,
    });
    expect(h.state.error).toBe("Send failed: network request failed");
    expect(h.releasePickedAttachment).not.toHaveBeenCalled();
  });

  it("clears the retained draft and attachments only after a matching acknowledgement", async () => {
    const h = await transientFailure();
    h.drafts.set("lifecycle:session", { draft: "original prompt" });
    h.acknowledge();
    expect(h.draft()).toBe("");
    expect(h.state.attachments).toEqual([]);
    expect(h.state.ack).toBeNull();
    expect(h.state.error).toBeNull();
    expect(h.releasePickedAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ uploadedAttachmentId: "uploaded-one" }),
    );
    expect(h.drafts.has("lifecycle:session")).toBe(false);
  });

  it("keeps a transient draft and attachments when the transcript has not acknowledged it", async () => {
    const h = await transientFailure();
    h.acknowledge([{ role: "user", parts: [{ type: "text", text: "unrelated prompt" }] }]);
    expect(h.draft()).toBe("original prompt");
    expect(h.state.attachments).toHaveLength(1);
    expect(h.state.ack).not.toBeNull();
    expect(h.state.error).toContain("network request failed");
    expect(h.releasePickedAttachment).not.toHaveBeenCalled();
  });

  it.each(["text", "attachments"])(
    "preserves edited %s when the older send is acknowledged",
    async (changed) => {
      const h = await transientFailure();
      if (changed === "text") h.setDraft("new draft");
      else h.state.attachments = [attachment("new")];
      const before = [...h.state.attachments];
      h.acknowledge();
      expect(h.draft()).toBe(changed === "text" ? "new draft" : "original prompt");
      expect(h.state.attachments).toEqual(before);
      expect(h.state.ack).toBeNull();
      expect(h.state.error).toBeNull();
      expect(h.releasePickedAttachment).not.toHaveBeenCalled();
    },
  );

  it("restores a nontransient failure without creating a pending acknowledgement", async () => {
    const h = harness([attachment()]);
    h.sendLivePaneInput.mockRejectedValueOnce(new Error("permission denied"));
    await h.send();
    expect(h.draft()).toBe("original prompt");
    expect(h.state.attachments[0]?.uploadedAttachmentId).toBe("uploaded-one");
    expect(h.state.ack).toBeNull();
    expect(h.state.error).toBe("Send failed: permission denied");
  });
});

describe("composer reservations across screen instances", () => {
  it("blocks another send after the pending composer unmounts and remounts", async () => {
    const shared = runtime();
    const firstScreen = harness([], shared);
    const response = deferred<{ accepted: boolean }>();
    shared.sendLivePaneInput.mockImplementation(() => response.promise);
    const first = firstScreen.send();
    firstScreen.unmount();
    const remounted = harness([], shared);
    remounted.reset();
    const second = remounted.send();
    try {
      expect(shared.sendLivePaneInput).toHaveBeenCalledTimes(1);
      expect(remounted.uiBusy()).toBe(true);
    } finally {
      response.resolve({ accepted: true });
      await Promise.all([first, second]);
    }
    expect(remounted.uiBusy()).toBe(false);
    remounted.setDraft("after settled");
    await remounted.send();
    expect(shared.sendLivePaneInput).toHaveBeenCalledTimes(2);
  });

  it("blocks a stale callback from another already mounted instance", async () => {
    const shared = runtime();
    const a = harness([], shared);
    const b = harness([], shared);
    const response = deferred<{ accepted: boolean }>();
    shared.sendLivePaneInput.mockImplementation(() => response.promise);
    const first = a.send();
    const second = b.send();
    try {
      expect(shared.sendLivePaneInput).toHaveBeenCalledTimes(1);
    } finally {
      response.resolve({ accepted: true });
      await Promise.all([first, second]);
    }
  });

  it("releases the old key after the reused screen sends on a newer route", async () => {
    const shared = runtime();
    const a = harness([], shared, "A");
    const response = deferred<{ accepted: boolean }>();
    shared.sendLivePaneInput.mockImplementationOnce(() => response.promise);
    const pending = a.send();
    const b = harness([], shared, "B", a.refs);
    b.reset();
    b.setDraft("different route");
    try {
      await b.send();
      expect(a.refs.sendOperationIdRef.current).toBe(2);
      expect(a.uiBusy()).toBe(true);
    } finally {
      response.resolve({ accepted: true });
      await pending;
    }
    expect(a.uiBusy()).toBe(false);
    expect(b.uiBusy()).toBe(false);
  });

  it("allows an independent composer key while the first key is pending", async () => {
    const shared = runtime();
    const a = harness([], shared, "A");
    const b = harness([], shared, "B");
    const response = deferred<{ accepted: boolean }>();
    shared.sendLivePaneInput.mockImplementationOnce(() => response.promise);
    const pending = a.send();
    try {
      await b.send();
      expect(shared.sendLivePaneInput).toHaveBeenCalledTimes(2);
      expect(a.uiBusy()).toBe(true);
      expect(b.uiBusy()).toBe(false);
    } finally {
      response.resolve({ accepted: true });
      await pending;
    }
  });

  it("publishes busy reservation changes reactively to another instance", async () => {
    const shared = runtime();
    const a = harness([], shared);
    const b = harness([], shared);
    const observed: boolean[] = [];
    const stop = shared.store.sub(b.composerSendOperationAtom, () => observed.push(b.uiBusy()));
    try {
      await a.send();
      expect(observed).toEqual([true, false]);
      expect(b.uiBusy()).toBe(false);
    } finally {
      stop();
    }
  });

  it("does not let a late completion release a replacement owner's token", async () => {
    const h = harness();
    const response = deferred<{ accepted: boolean }>();
    h.sendLivePaneInput.mockImplementationOnce(() => response.promise);
    const pending = h.send();
    const newer = Symbol("newer send owner");
    h.shared.store.set(h.composerSendOperationAtom, newer);
    response.resolve({ accepted: true });
    await pending;
    expect(h.shared.store.get(h.composerSendOperationAtom)).toBe(newer);
  });

  it("releases reservation and local guard when synchronous send setup throws", async () => {
    const h = harness();
    h.clearLocalInterruptHold.mockImplementationOnce(() => {
      throw new Error("setup exploded");
    });
    await h.send();
    expect(h.state.error).toBe("Send failed: setup exploded");
    expect(h.sendBusyRef.current).toBe(false);
    expect(h.shared.store.get(h.composerSendOperationAtom)).toBeNull();
    h.setDraft("retry after setup error");
    await h.send();
    expect(h.sendLivePaneInput).toHaveBeenCalledTimes(1);
  });
});
