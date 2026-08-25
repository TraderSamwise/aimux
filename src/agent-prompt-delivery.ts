import type { TmuxTarget } from "./tmux/runtime-manager.js";

interface PromptTmuxRuntime {
  captureTarget(target: TmuxTarget, options?: { startLine?: number; includeEscapes?: boolean }): string;
  sendCarriageReturn(target: TmuxTarget): void;
  sendText(target: TmuxTarget, text: string): void;
}

export interface VisiblePromptInputDraft {
  marker: "codex" | "claude";
  text: string;
  line: string;
}

export type PromptInputBufferEvent =
  | {
      kind: "start" | "change";
      waitedMs: number;
      polls: number;
      changes: number;
      draft: VisiblePromptInputDraft;
    }
  | {
      kind: "idle" | "force" | "cleared" | "target-changed";
      waitedMs: number;
      polls: number;
      changes: number;
      draft?: VisiblePromptInputDraft;
    };

export interface PromptInputIdleResult {
  ok: boolean;
  reason: "no-draft" | "idle" | "force" | "cleared" | "target-changed";
  waitedMs: number;
  polls: number;
  changes: number;
  draft?: VisiblePromptInputDraft;
}

export function normalizeSubmittedPrompt(tool: string | undefined, data: string, submit: boolean): string {
  if (!submit) return data;
  const trimmed = data.replace(/(?:\r\n|\r|\n)+$/g, "");
  return trimmed.replace(/\s*(?:\r\n|\r|\n)+\s*/g, " ");
}

export function paneStillContainsPromptDraft(
  tmuxRuntimeManager: PromptTmuxRuntime,
  target: TmuxTarget,
  draft: string,
): boolean {
  try {
    const pane = tmuxRuntimeManager.captureTarget(target, { startLine: -60 });
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
    const normalizedPane = normalize(pane);
    const normalizedDraft = normalize(draft);
    if (!normalizedDraft) return false;
    if (normalizedPane.includes(normalizedDraft)) return true;
    if (normalizedPane.includes("[pasted content")) return true;
    const fragments = normalizedDraft
      .split(/[.!?]\s+/)
      .map((fragment) => fragment.trim())
      .filter((fragment) => fragment.length >= 24)
      .slice(0, 3);
    return fragments.some((fragment) => normalizedPane.includes(fragment));
  } catch {
    return false;
  }
}

function capturePromptDraftSignature(tmuxRuntimeManager: PromptTmuxRuntime, target: TmuxTarget): string {
  try {
    const pane = tmuxRuntimeManager.captureTarget(target, { startLine: -20 });
    return pane.replace(/\s+/g, " ").trim().slice(-240);
  } catch {
    return "";
  }
}

export function detectVisiblePromptInputDraft(pane: string): VisiblePromptInputDraft | null {
  const nonEmptyTail = pane
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-8);
  for (let index = nonEmptyTail.length - 1; index >= Math.max(0, nonEmptyTail.length - 3); index -= 1) {
    const line = nonEmptyTail[index] ?? "";
    const match = /^\s*([›❯])\s*(.*\S)\s*$/.exec(line);
    if (!match) continue;
    return {
      marker: match[1] === "❯" ? "claude" : "codex",
      text: match[2].trim(),
      line,
    };
  }
  return null;
}

export function captureVisiblePromptInputDraft(
  tmuxRuntimeManager: PromptTmuxRuntime,
  target: TmuxTarget,
): VisiblePromptInputDraft | null {
  try {
    return detectVisiblePromptInputDraft(tmuxRuntimeManager.captureTarget(target, { startLine: -12 }));
  } catch {
    return null;
  }
}

export function waitForVisiblePromptInputIdle(opts: {
  tmuxRuntimeManager: PromptTmuxRuntime;
  target: TmuxTarget;
  isTargetCurrent: () => boolean;
  stablePolls?: number;
  pollMs?: number;
  maxWaitMs?: number;
  onEvent?: (event: PromptInputBufferEvent) => void;
}): Promise<PromptInputIdleResult> {
  const { tmuxRuntimeManager, target, isTargetCurrent } = opts;
  const requiredStablePolls = Math.max(1, opts.stablePolls ?? 3);
  const pollMs = Math.max(1, opts.pollMs ?? 1_000);
  const maxWaitMs = Math.max(pollMs, opts.maxWaitMs ?? 10_000);
  const initial = captureVisiblePromptInputDraft(tmuxRuntimeManager, target);
  if (!initial) {
    return Promise.resolve({ ok: true, reason: "no-draft", waitedMs: 0, polls: 0, changes: 0 });
  }
  opts.onEvent?.({ kind: "start", waitedMs: 0, polls: 0, changes: 0, draft: initial });

  return new Promise((resolve) => {
    let lastText = initial.text;
    let stableCount = 0;
    let polls = 0;
    let changes = 0;
    const poll = () => {
      setTimeout(() => {
        polls += 1;
        const waitedMs = polls * pollMs;
        try {
          if (!isTargetCurrent()) {
            const result = { ok: false, reason: "target-changed" as const, waitedMs, polls, changes };
            opts.onEvent?.({ kind: "target-changed", waitedMs, polls, changes });
            resolve(result);
            return;
          }
          const draft = captureVisiblePromptInputDraft(tmuxRuntimeManager, target);
          if (!draft) {
            const result = { ok: true, reason: "cleared" as const, waitedMs, polls, changes };
            opts.onEvent?.({ kind: "cleared", waitedMs, polls, changes });
            resolve(result);
            return;
          }
          if (draft.text === lastText) {
            stableCount += 1;
          } else {
            lastText = draft.text;
            stableCount = 0;
            changes += 1;
            opts.onEvent?.({ kind: "change", waitedMs, polls, changes, draft });
          }
          if (stableCount >= requiredStablePolls) {
            const result = { ok: true, reason: "idle" as const, waitedMs, polls, changes, draft };
            opts.onEvent?.({ kind: "idle", waitedMs, polls, changes, draft });
            resolve(result);
            return;
          }
          if (waitedMs >= maxWaitMs) {
            const result = { ok: true, reason: "force" as const, waitedMs, polls, changes, draft };
            opts.onEvent?.({ kind: "force", waitedMs, polls, changes, draft });
            resolve(result);
            return;
          }
          poll();
        } catch {
          if (waitedMs >= maxWaitMs) {
            const result = { ok: true, reason: "force" as const, waitedMs, polls, changes };
            opts.onEvent?.({ kind: "force", waitedMs, polls, changes });
            resolve(result);
            return;
          }
          poll();
        }
      }, pollMs);
    };
    poll();
  });
}

export function waitForTmuxPromptSubmit(opts: {
  tmuxRuntimeManager: PromptTmuxRuntime;
  target: TmuxTarget;
  draft: string;
  isTargetCurrent: () => boolean;
}): Promise<boolean> {
  const { tmuxRuntimeManager, target, draft, isTargetCurrent } = opts;
  return new Promise((resolve) => {
    const submitStep = (attempt = 1) => {
      if (attempt > 4) {
        resolve(false);
        return;
      }
      setTimeout(
        () => {
          try {
            if (!isTargetCurrent()) {
              resolve(false);
              return;
            }
            tmuxRuntimeManager.sendCarriageReturn(target);
            if (attempt >= 4) {
              resolve(true);
              return;
            }
            setTimeout(() => {
              try {
                if (paneStillContainsPromptDraft(tmuxRuntimeManager, target, draft)) {
                  submitStep(attempt + 1);
                  return;
                }
              } catch {
                // Treat capture failures after a submit attempt as non-fatal.
              }
              resolve(true);
            }, 700);
          } catch {
            resolve(false);
          }
        },
        attempt === 1 ? 200 : 700,
      );
    };

    const waitForDraft = (attempt = 1, visibleCount = 0, lastSignature = "") => {
      if (attempt > 20) {
        submitStep(1);
        return;
      }
      setTimeout(
        () => {
          try {
            if (!isTargetCurrent()) {
              resolve(false);
              return;
            }
            const stillDraft = paneStillContainsPromptDraft(tmuxRuntimeManager, target, draft);
            const signature = stillDraft ? capturePromptDraftSignature(tmuxRuntimeManager, target) : "";
            const nextVisibleCount =
              stillDraft && signature && signature === lastSignature ? visibleCount + 1 : stillDraft ? 1 : 0;
            if (nextVisibleCount >= 2) {
              submitStep(1);
              return;
            }
            waitForDraft(attempt + 1, nextVisibleCount, signature);
          } catch {
            waitForDraft(attempt + 1, visibleCount, lastSignature);
          }
        },
        attempt === 1 ? 300 : 250,
      );
    };

    waitForDraft();
  });
}

export function scheduleTmuxPromptSubmit(opts: {
  tmuxRuntimeManager: PromptTmuxRuntime;
  target: TmuxTarget;
  draft: string;
  isTargetCurrent: () => boolean;
}): void {
  void waitForTmuxPromptSubmit(opts);
}

export async function deliverTmuxPrompt(opts: {
  tmuxRuntimeManager: PromptTmuxRuntime;
  target: TmuxTarget;
  prompt: string;
  submit?: boolean;
  isTargetCurrent: () => boolean;
}): Promise<boolean> {
  const { tmuxRuntimeManager, target, prompt, submit = false, isTargetCurrent } = opts;
  if (!isTargetCurrent()) return false;
  tmuxRuntimeManager.sendText(target, prompt);
  if (!submit) return true;
  return waitForTmuxPromptSubmit({ tmuxRuntimeManager, target, draft: prompt, isTargetCurrent });
}
