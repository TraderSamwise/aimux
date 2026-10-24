import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  endpoint: { host: "127.0.0.1", port: 43191 },
  getToken: vi.fn(async (): Promise<string | null> => null),
  refreshOutputSnapshot: vi.fn(async () => true),
  sendLivePaneInput: vi.fn(),
  router: { back: vi.fn(), push: vi.fn(), replace: vi.fn() },
  getShare: vi.fn(),
  listShares: vi.fn(),
  // The route and the storage read are per-test, because the cases that
  // matter are a canonical shared route and a read that never settles.
  pathname: "/agent/codex-component",
  params: { sessionId: "codex-component" } as Record<string, string>,
  storage: () => Promise.resolve(null) as Promise<string | null>,
}));

vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    useFocusEffect: (callback: React.EffectCallback) => useEffect(callback, [callback]),
    useLocalSearchParams: () => boundary.params,
    usePathname: () => boundary.pathname,
    useRouter: () => boundary.router,
  };
});

vi.mock("@/lib/use-route-project", () => ({
  useRouteProject: () => ({
    project: { id: "repo", name: "repo", path: "/repo" },
    projectPath: "/repo",
    routeProjectPath: "/repo",
    projectRef: { path: "/repo" },
    machineId: null,
    endpoint: boundary.endpoint,
    projectLoading: false,
  }),
}));
vi.mock("@/lib/use-route-share", () => ({ useRouteShare: () => null }));
vi.mock("@/lib/main-tabs", () => ({ buildMainTabHref: () => "/" }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ getToken: boundary.getToken }),
  useUser: () => ({ user: null }),
}));
vi.mock("@/lib/use-agent-output-feed", () => ({
  useAgentOutputFeed: () => ({
    initialStatus: "idle",
    refreshOutputSnapshot: boundary.refreshOutputSnapshot,
  }),
}));
vi.mock("@/lib/api", () => ({
  sendLivePaneInput: boundary.sendLivePaneInput,
  markSessionSeen: vi.fn(async () => ({ ok: true })),
  getShare: boundary.getShare,
  listShares: boundary.listShares,
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(() => boundary.storage()),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
  },
}));
vi.mock("nativewind", () => ({ useColorScheme: () => ({ colorScheme: "dark" }) }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("react-native-keyboard-controller", async () => {
  const { ScrollView, View } = await import("react-native");
  return { KeyboardChatScrollView: ScrollView, KeyboardStickyView: View };
});
vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  const { View, Text } = await import("react-native");
  return {
    default: { View, Text },
    useSharedValue: (value: unknown) => useRef({ value }).current,
    useAnimatedStyle: (callback: () => unknown) => callback(),
    withTiming: (value: unknown) => value,
    withRepeat: (value: unknown) => value,
    interpolateColor: () => "#a1a1aa",
    Easing: { in: (value: unknown) => value, out: (value: unknown) => value },
    ReduceMotion: { System: "system" },
  };
});
vi.mock("lucide-react-native", async () => {
  const { createElement } = await import("react");
  const names = [
    "ArrowUp",
    "ChevronDown",
    "ChevronLeft",
    "Check",
    "Clock",
    "CircleAlert",
    "Columns2",
    "MessageSquareText",
    "Plus",
    "SlidersHorizontal",
    "Square",
    "Terminal",
    "UserPlus",
    "X",
  ];
  return Object.fromEntries(
    names.map((name) => [
      name,
      ({ color }: { color?: string }) =>
        createElement("svg", { "data-testid": `icon-${name}`, stroke: color }),
    ]),
  );
});
vi.mock("@/lib/image-picker", () => ({
  attachmentsFromClipboardData: vi.fn(async () => []),
  clipboardDataHasFile: () => false,
  pickAttachments: vi.fn(async () => []),
  pickedAttachmentDataBase64: vi.fn(),
  releasePickedAttachment: vi.fn(),
}));
vi.mock("@/components/agent-actions", () => ({ AgentActions: () => null }));
vi.mock("@/components/agent-management-panel", () => ({ AgentManagementPanel: () => null }));
vi.mock("@/components/teammate-panel", () => ({ TeammatePanel: () => null }));
vi.mock("@/components/MessageBlock", () => ({ MessageBlock: () => null }));
vi.mock("@/lib/hardware-keyboard", () => ({ useHasHardwareKeyboard: () => true }));
vi.mock("@/lib/use-keyboard-visible", () => ({ useKeyboardVisible: () => false }));

import ChatScreen from "@/components/screens/AgentChatScreen";
import { COMPOSER_SEND_AWAITING_ECHO_NOTICE } from "@/lib/composer-footer";
import { agentStateKey, projectStateKey } from "@/lib/project-key";
import { ResponsiveViewportProvider } from "@/lib/responsive-viewport";
import { createResponsiveViewportValue } from "@/lib/responsive-viewport-core";
import { outputAvailableFamily, outputBufferFamily } from "@/stores/chat";
import { desktopStateFamily } from "@/stores/desktopState";
import {
  agentOutputViewModeAtom,
  settingsHydratedAtom,
  type AgentOutputViewMode,
} from "@/stores/settings";

const sessionId = "codex-component";
const viewport = createResponsiveViewportValue({
  width: 1200,
  height: 800,
  isDesktopNative: false,
});

async function mountChat(
  mode: AgentOutputViewMode = "terminal",
  options: {
    store?: ReturnType<typeof createStore>;
    draft?: string | null;
    // A read that never settles never hydrates, and that is the case under
    // test -- so waiting for it would hang rather than fail.
    awaitHydration?: boolean;
  } = {},
) {
  const store = options.store ?? createStore();
  if (options.awaitHydration !== false) {
    await waitFor(() => expect(store.get(settingsHydratedAtom)).toBe(true));
  }
  const project = projectStateKey({ path: "/repo" });
  const agent = agentStateKey(project, sessionId);
  store.set(desktopStateFamily(project), {
    ok: true,
    sessions: [{ id: sessionId, status: "running", command: "codex", worktreePath: "/repo" }],
    services: [],
    worktrees: [],
    mainCheckoutPath: "/repo",
  });
  store.set(outputBufferFamily(agent), "terminal fixture output");
  store.set(outputAvailableFamily(agent), true);
  store.set(agentOutputViewModeAtom, mode);
  const mounted = render(
    <Provider store={store}>
      <ResponsiveViewportProvider value={viewport}>
        <ChatScreen />
      </ResponsiveViewportProvider>
    </Provider>,
  );
  await act(async () => {});
  fireEvent.click(
    screen.getByRole("button", { name: mode === "terminal" ? "Show output" : "Show chat" }),
  );
  expect(store.get(agentOutputViewModeAtom)).toBe(mode);
  const input = screen.getByRole("textbox", { name: "Message the agent" });
  if (options.draft !== null)
    fireEvent.change(input, {
      target: { value: options.draft ?? "Please inspect this component" },
    });
  const send = screen.getByRole("button", { name: "Send the message" });
  if (options.draft !== null) expect(send.getAttribute("aria-disabled")).not.toBe("true");
  return { input, send, store, unmount: mounted.unmount };
}

function deferredSend() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  boundary.sendLivePaneInput.mockReturnValueOnce(promise);
  return () => resolve({ ok: true, sessionId, accepted: true, delivery: { state: "delivered" } });
}

async function sendMessage(mode: AgentOutputViewMode = "terminal") {
  const controls = await mountChat(mode);
  await act(async () => fireEvent.click(controls.send));
  await waitFor(() => expect(boundary.sendLivePaneInput).toHaveBeenCalledTimes(1));
  expect(boundary.sendLivePaneInput).toHaveBeenCalledWith(
    boundary.endpoint,
    sessionId,
    "Please inspect this component",
    expect.any(Object),
  );
  await waitFor(() => expect((controls.input as HTMLTextAreaElement).value).toBe(""));
  expect(screen.queryByText("Sending...")).toBeNull();
}

describe("AgentChatScreen mounted web composer footer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boundary.pathname = "/agent/codex-component";
    boundary.params = { sessionId: "codex-component" };
    boundary.storage = () => Promise.resolve(null);
    boundary.getToken.mockResolvedValue(null);
    boundary.sendLivePaneInput.mockResolvedValue({
      ok: true,
      sessionId,
      accepted: true,
      delivery: { state: "delivered" },
    });
  });

  it("disables the mounted send button while input is pending and permits the next send", async () => {
    const complete = deferredSend();
    const { input, send } = await mountChat();
    try {
      await act(async () => fireEvent.click(send));
      await waitFor(() => expect(boundary.sendLivePaneInput).toHaveBeenCalledTimes(1));
      expect(send.getAttribute("aria-disabled")).toBe("true");
      expect(
        screen.getByRole("button", { name: "Attach a file" }).getAttribute("aria-disabled"),
      ).toBe("true");
      expect(screen.getByText("Sending...")).toBeTruthy();
      await act(async () => fireEvent.click(send));
      expect(boundary.sendLivePaneInput).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => complete());
    }
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
    expect(screen.queryByText("Sending...")).toBeNull();
    fireEvent.change(input, { target: { value: "Send after the first request settles" } });
    expect(send.getAttribute("aria-disabled")).not.toBe("true");
    await act(async () => fireEvent.click(send));
    await waitFor(() => expect(boundary.sendLivePaneInput).toHaveBeenCalledTimes(2));
    expect(boundary.sendLivePaneInput.mock.calls[1]?.[2]).toBe(
      "Send after the first request settles",
    );
  });

  it("keeps the mounted send button disabled across a pending remount", async () => {
    const complete = deferredSend();
    const first = await mountChat();
    let remounted: Awaited<ReturnType<typeof mountChat>> | undefined;
    try {
      await act(async () => fireEvent.click(first.send));
      await waitFor(() => expect(boundary.sendLivePaneInput).toHaveBeenCalledTimes(1));
      first.unmount();
      remounted = await mountChat("terminal", { store: first.store, draft: null });
      expect((remounted.input as HTMLTextAreaElement).value).toBe("Please inspect this component");
      expect(remounted.send.getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByText("Sending...")).toBeTruthy();
      await act(async () => fireEvent.click(remounted!.send));
      expect(boundary.sendLivePaneInput).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => complete());
    }
    expect(remounted).toBeDefined();
    await waitFor(() => expect(screen.queryByText("Sending...")).toBeNull());
    fireEvent.change(remounted!.input, { target: { value: "Send from the remounted composer" } });
    expect(remounted!.send.getAttribute("aria-disabled")).not.toBe("true");
    await act(async () => fireEvent.click(remounted!.send));
    await waitFor(() => expect(boundary.sendLivePaneInput).toHaveBeenCalledTimes(2));
    expect(boundary.sendLivePaneInput.mock.calls[1]?.[2]).toBe("Send from the remounted composer");
  });

  it("renders an accepted send awaiting its echo in terminal mode", async () => {
    await sendMessage();
    expect(screen.getByText("terminal fixture output")).toBeTruthy();
    const notice = screen.getByText(COMPOSER_SEND_AWAITING_ECHO_NOTICE);
    expect(within(notice.parentElement!).queryByTestId("icon-CircleAlert")).toBeNull();
  });

  it("renders accepted held input as pending rather than an error", async () => {
    boundary.sendLivePaneInput.mockResolvedValue({
      ok: true,
      sessionId,
      accepted: true,
      delivery: {
        state: "held",
        reason: "visible-unsubmitted-input-recent-user-input",
        retryAfterMs: 15_000,
      },
    });
    await sendMessage();
    const notice = screen.getByText(
      "Input held, not delivered yet: the agent terminal already has typed text. Clear or send that terminal draft, or Aimux will send this after the 15s safety hold.",
    );
    expect(within(notice.parentElement!).getByTestId("icon-Clock").getAttribute("stroke")).toBe(
      "#e0b341",
    );
    expect(within(notice.parentElement!).queryByTestId("icon-CircleAlert")).toBeNull();
    expect(screen.queryByText(COMPOSER_SEND_AWAITING_ECHO_NOTICE)).toBeNull();
  });

  it("renders a genuine send failure as an error rather than pending", async () => {
    boundary.sendLivePaneInput.mockRejectedValue(new Error("component send endpoint refused"));
    const { send, input } = await mountChat();
    await act(async () => fireEvent.click(send));
    const notice = await screen.findByText(/component send endpoint refused/);
    expect(
      within(notice.parentElement!).getByTestId("icon-CircleAlert").getAttribute("stroke"),
    ).toBe("#f87171");
    expect(within(notice.parentElement!).queryByTestId("icon-Clock")).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe("Please inspect this component");
    expect(screen.queryByText(COMPOSER_SEND_AWAITING_ECHO_NOTICE)).toBeNull();
  });

  it("does not duplicate a transcript-mode accepted send in the footer", async () => {
    await sendMessage("chat");
    expect(screen.queryByText(COMPOSER_SEND_AWAITING_ECHO_NOTICE)).toBeNull();
    expect(screen.queryByTestId("icon-CircleAlert")).toBeNull();
  });
});
