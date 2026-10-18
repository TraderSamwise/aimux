import { act, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  getToken: vi.fn(async () => null),
  updateThreadStatus: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ getToken: boundary.getToken }) }));
vi.mock("@/lib/api", () => ({
  acceptTask: vi.fn(),
  approveReview: vi.fn(),
  blockTask: vi.fn(),
  cancelTask: vi.fn(),
  completeTask: vi.fn(),
  markThreadSeen: vi.fn(),
  reopenTask: vi.fn(),
  requestReviewChanges: vi.fn(),
  sendThreadMessage: vi.fn(),
  updateThreadStatus: boundary.updateThreadStatus,
}));
vi.mock("lucide-react-native", () => ({
  Ban: () => null,
  CheckCircle2: () => null,
  Eye: () => null,
  MessageSquareReply: () => null,
  RotateCcw: () => null,
  ThumbsUp: () => null,
  XCircle: () => null,
}));

import { ThreadWorkflowActions } from "@/components/workflow-actions";

const endpoint = { host: "127.0.0.1", port: 43191 };

describe("ThreadWorkflowActions mounted web terminal state", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["closed", true, "Reopen", "Close", "open"],
    ["open", false, "Close", "Reopen", "done"],
    ["open", true, "Reopen", "Close", "open"],
    ["done", false, "Close", "Reopen", "done"],
  ] as const)(
    "renders %s with server terminal=%s as %s and sends the corresponding action",
    async (status, terminal, action, absentAction, nextStatus) => {
      render(
        <Provider store={createStore()}>
          <ThreadWorkflowActions
            endpoint={endpoint}
            thread={{ thread: { id: "thread-component", status }, terminal }}
          />
        </Provider>,
      );
      expect(screen.queryByText(absentAction)).toBeNull();
      await act(async () => fireEvent.click(screen.getByText(action)));
      expect(boundary.updateThreadStatus).toHaveBeenCalledExactlyOnceWith(
        endpoint,
        { threadId: "thread-component", status: nextStatus, owner: "user" },
        { token: null },
      );
    },
  );
});
