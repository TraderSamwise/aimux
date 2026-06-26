import React, { useState } from "react";
import { View } from "react-native";
import { useSetAtom } from "jotai";
import {
  Ban,
  CheckCircle2,
  Eye,
  MessageSquareReply,
  RotateCcw,
  ThumbsUp,
} from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import {
  acceptTask,
  approveReview,
  blockTask,
  completeTask,
  markThreadSeen,
  reopenTask,
  requestReviewChanges,
  sendThreadMessage,
  updateThreadStatus,
  type TaskSummaryResponse,
  type ThreadSummaryResponse,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import { kickProjectApiViewRefreshAtom } from "@/stores/projectViews";

type WorkflowAction = "accept" | "block" | "complete" | "reopen" | "approve" | "changes";

export function TaskWorkflowActions({
  endpoint,
  task,
}: {
  endpoint: ServiceEndpoint | null;
  task: TaskSummaryResponse;
}) {
  const { getToken } = useAuth();
  const kickProjectRefresh = useSetAtom(kickProjectApiViewRefreshAtom);
  const [busyAction, setBusyAction] = useState<WorkflowAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = String(task.status ?? "").toLowerCase();
  const isClosed = status === "done" || status === "failed" || status === "abandoned";
  const isReview =
    String((task as Record<string, unknown>).type ?? "") === "review" || Boolean(task.reviewOf);
  const canAct = Boolean(endpoint) && !busyAction;

  async function runAction(action: WorkflowAction, fn: (token: string | null) => Promise<unknown>) {
    if (!endpoint || busyAction) return;
    setBusyAction(action);
    setError(null);
    try {
      const token = await getToken();
      await fn(token);
      kickProjectRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyAction(null);
    }
  }

  if (!endpoint) return null;

  return (
    <View className="mt-3">
      <View className="flex-row flex-wrap gap-2">
        {isClosed ? (
          <WorkflowButton
            icon={RotateCcw}
            label={busyAction === "reopen" ? "Reopening" : "Reopen"}
            disabled={!canAct}
            onPress={() =>
              runAction("reopen", (token) =>
                reopenTask(endpoint, { taskId: task.id, from: "user" }, { token }),
              )
            }
          />
        ) : isReview ? (
          <>
            <WorkflowButton
              icon={ThumbsUp}
              label={busyAction === "approve" ? "Approving" : "Approve"}
              disabled={!canAct}
              onPress={() =>
                runAction("approve", (token) =>
                  approveReview(
                    endpoint,
                    { taskId: task.id, from: "user", body: "Approved from web." },
                    { token },
                  ),
                )
              }
            />
            <WorkflowButton
              icon={Ban}
              label={busyAction === "changes" ? "Requesting" : "Changes"}
              disabled={!canAct}
              onPress={() =>
                runAction("changes", (token) =>
                  requestReviewChanges(
                    endpoint,
                    { taskId: task.id, from: "user", body: "Changes requested from web." },
                    { token },
                  ),
                )
              }
            />
          </>
        ) : (
          <>
            {status !== "in_progress" ? (
              <WorkflowButton
                icon={Eye}
                label={busyAction === "accept" ? "Accepting" : "Accept"}
                disabled={!canAct}
                onPress={() =>
                  runAction("accept", (token) =>
                    acceptTask(endpoint, { taskId: task.id, from: "user" }, { token }),
                  )
                }
              />
            ) : null}
            {status !== "blocked" ? (
              <WorkflowButton
                icon={Ban}
                label={busyAction === "block" ? "Blocking" : "Block"}
                disabled={!canAct}
                onPress={() =>
                  runAction("block", (token) =>
                    blockTask(
                      endpoint,
                      { taskId: task.id, from: "user", body: "Blocked from web." },
                      { token },
                    ),
                  )
                }
              />
            ) : null}
            <WorkflowButton
              icon={CheckCircle2}
              label={busyAction === "complete" ? "Completing" : "Done"}
              disabled={!canAct}
              onPress={() =>
                runAction("complete", (token) =>
                  completeTask(
                    endpoint,
                    { taskId: task.id, from: "user", body: "Completed from web." },
                    { token },
                  ),
                )
              }
            />
          </>
        )}
      </View>
      {error ? <Text className="mt-2 text-xs text-destructive">{error}</Text> : null}
    </View>
  );
}

export function ThreadWorkflowActions({
  endpoint,
  thread,
}: {
  endpoint: ServiceEndpoint | null;
  thread: ThreadSummaryResponse;
}) {
  const { getToken } = useAuth();
  const kickProjectRefresh = useSetAtom(kickProjectApiViewRefreshAtom);
  const [draft, setDraft] = useState("");
  const [busyAction, setBusyAction] = useState<"seen" | "reply" | "close" | "reopen" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const threadId = thread.thread.id;
  const status = String(thread.thread.status ?? "").toLowerCase();
  const isClosed = status === "done" || status === "abandoned";
  const canAct = Boolean(endpoint) && !busyAction;
  const body = draft.trim();

  async function runAction(
    action: "seen" | "reply" | "close" | "reopen",
    fn: (token: string | null) => Promise<unknown>,
  ) {
    if (!endpoint || busyAction) return;
    setBusyAction(action);
    setError(null);
    try {
      const token = await getToken();
      await fn(token);
      if (action === "reply") setDraft("");
      kickProjectRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyAction(null);
    }
  }

  if (!endpoint) return null;

  return (
    <View className="mt-3 border-t border-border pt-3">
      <View className="flex-row flex-wrap gap-2">
        <WorkflowButton
          icon={Eye}
          label={busyAction === "seen" ? "Marking" : "Seen"}
          disabled={!canAct}
          onPress={() =>
            runAction("seen", (token) =>
              markThreadSeen(endpoint, { threadId, session: "user" }, { token }),
            )
          }
        />
        {isClosed ? (
          <WorkflowButton
            icon={RotateCcw}
            label={busyAction === "reopen" ? "Reopening" : "Reopen"}
            disabled={!canAct}
            onPress={() =>
              runAction("reopen", (token) =>
                updateThreadStatus(
                  endpoint,
                  { threadId, status: "open", owner: "user" },
                  { token },
                ),
              )
            }
          />
        ) : (
          <WorkflowButton
            icon={CheckCircle2}
            label={busyAction === "close" ? "Closing" : "Close"}
            disabled={!canAct}
            onPress={() =>
              runAction("close", (token) =>
                updateThreadStatus(
                  endpoint,
                  { threadId, status: "done", owner: "user" },
                  { token },
                ),
              )
            }
          />
        )}
      </View>
      <View className="mt-3 flex-row gap-2">
        <Input
          value={draft}
          onChangeText={setDraft}
          placeholder="Reply"
          className="h-9 flex-1 text-sm"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={!canAct || !body}
          onPress={() =>
            runAction("reply", (token) =>
              sendThreadMessage(
                endpoint,
                { threadId, from: "user", kind: "reply", body },
                { token },
              ),
            )
          }
          className="gap-2"
        >
          <MessageSquareReply size={14} color="#a1a1aa" />
          <Text className="text-sm text-foreground">
            {busyAction === "reply" ? "Sending" : "Send"}
          </Text>
        </Button>
      </View>
      {error ? <Text className="mt-2 text-xs text-destructive">{error}</Text> : null}
    </View>
  );
}

function WorkflowButton({
  icon: Icon,
  label,
  disabled,
  onPress,
}: {
  icon: typeof CheckCircle2;
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Button variant="outline" size="sm" disabled={disabled} onPress={onPress} className="gap-2">
      <Icon size={14} color="#a1a1aa" />
      <Text className="text-sm text-foreground">{label}</Text>
    </Button>
  );
}
