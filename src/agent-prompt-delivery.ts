import type { TmuxTarget } from "./tmux/runtime-manager.js";

interface PromptTmuxRuntime {
  captureTarget(target: TmuxTarget, options?: { startLine?: number; includeEscapes?: boolean }): string;
  sendCarriageReturn(target: TmuxTarget): void;
  sendText(target: TmuxTarget, text: string): void;
}

export function normalizeSubmittedPrompt(tool: string | undefined, data: string, submit: boolean): string {
  if (!submit) return data;
  const trimmed = data.replace(/(?:\r\n|\r|\n)+$/g, "");
  if (tool === "codex") {
    return trimmed.replace(/\s*(?:\r\n|\r|\n)+\s*/g, " ");
  }
  return trimmed;
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
