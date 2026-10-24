import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { projectStateKey } from "@/lib/project-key";
import { ResponsiveViewportProvider } from "@/lib/responsive-viewport";
import { createResponsiveViewportValue } from "@/lib/responsive-viewport-core";
import { desktopStateFamily } from "@/stores/desktopState";
import { settingsHydratedAtom } from "@/stores/settings";
import { relayConfiguredAtom } from "@/stores/relay";

const sessionId = "codex-component";
const viewport = createResponsiveViewportValue({
  width: 1200,
  height: 800,
  isDesktopNative: false,
});

// A file of its own, deliberately. `storageReadStateAtom` latches the last
// value storage returned in a module-level map keyed by the ATOM, so in a
// process with several stores -- which only tests have -- an earlier test's
// resolved read answers for a later one's. A read that never settles has to be
// the first thing this module's atoms ever see.
//
// The one behavioural test for the bug that source-text gates could not see:
// `shareSummaryCheckedKey` is the owner's send gate through
// `ownerShareStatusPending`, and twice a storage read was allowed to decide
// it -- first by gating the fetch, then by withholding the latch on a
// canonical shared route. Both times the composer accepted text and did
// nothing, because `handleSendMessage` returns without setting an error.
describe("the owner's send gate and the stored settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // An owner opening their OWN share link. `useRouteShare` is null here
    // because `acceptedShares` is the default empty list while unread, which
    // is exactly what made `!isSharedSessionView` true.
    boundary.pathname = "/shares/owner_1/share_1/agent/codex-component/chat";
    boundary.params = {
      ownerUserId: "owner_1",
      shareId: "share_1",
      sessionId: "codex-component",
    };
    // Both are required, or `shareSummaryRequestKey` is null and the gate is
    // open for the wrong reason.
    boundary.getToken.mockResolvedValue("owner-token");
    boundary.getShare.mockResolvedValue({
      share: {
        id: "share_1",
        ownerUserId: "owner_1",
        projectRoot: "/repo",
        sessionId: "codex-component",
        serviceEndpoint: boundary.endpoint,
        participants: [],
        invites: [],
      },
    });
    boundary.listShares.mockResolvedValue({ shares: [] });
    boundary.sendLivePaneInput.mockResolvedValue({
      ok: true,
      submitted: true,
      verification: "verified",
    });
  });

  // Its own mount rather than `mountChat`: a shared route renders the chat
  // directly, with no view-mode toggle to click.
  async function mountSharedChat() {
    const store = createStore();
    store.set(relayConfiguredAtom, true);
    const project = projectStateKey({ path: "/repo" });
    store.set(desktopStateFamily(project), {
      ok: true,
      sessions: [{ id: sessionId, status: "running", command: "codex", worktreePath: "/repo" }],
      services: [],
      worktrees: [],
      mainCheckoutPath: "/repo",
    });
    const mounted = render(
      <Provider store={store}>
        <ResponsiveViewportProvider value={viewport}>
          <ChatScreen />
        </ResponsiveViewportProvider>
      </Provider>,
    );
    await act(async () => {});
    return { store, unmount: mounted.unmount };
  }

  it("can still send when the stored settings never arrive", async () => {
    // The read that never answers. Nothing about it may reach the composer.
    boundary.storage = () => new Promise<string | null>(() => {});

    const { store } = await mountSharedChat();

    expect(store.get(settingsHydratedAtom), "the premise: it never hydrated").toBe(false);
    const input = screen.getByRole("textbox", { name: "Message the agent" });
    fireEvent.change(input, { target: { value: "does the gate let this through" } });
    const send = screen.getByRole("button", { name: "Send the message" });
    expect(send.getAttribute("aria-disabled"), "and the owner can still send").not.toBe("true");
  });

  it("still fetches the share summary, which is what clears that gate", async () => {
    boundary.storage = () => new Promise<string | null>(() => {});

    await mountSharedChat();

    await waitFor(() => expect(boundary.getShare).toHaveBeenCalled());
  });
});
