import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  endpoint: { host: "127.0.0.1", port: 43191 },
  getToken: vi.fn(async () => null),
  refreshOutputSnapshot: vi.fn(async () => true),
  sendLivePaneInput: vi.fn(),
  router: { back: vi.fn(), push: vi.fn(), replace: vi.fn() },
}));

vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    useFocusEffect: (callback: React.EffectCallback) => useEffect(callback, [callback]),
    useLocalSearchParams: () => ({ sessionId: "codex-component" }),
    usePathname: () => "/agent/codex-component",
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
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
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

async function mountChat(mode: AgentOutputViewMode = "terminal") {
  const store = createStore();
  await waitFor(() => expect(store.get(settingsHydratedAtom)).toBe(true));
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
  render(
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
  fireEvent.change(input, { target: { value: "Please inspect this component" } });
  const send = screen.getByRole("button", { name: "Send the message" });
  expect(send.getAttribute("aria-disabled")).not.toBe("true");
  return { input, send };
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
    boundary.sendLivePaneInput.mockResolvedValue({
      ok: true,
      sessionId,
      accepted: true,
      delivery: { state: "delivered" },
    });
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
