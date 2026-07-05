import type { CoreTmuxTarget } from "./core-command-contract.js";
import { TmuxRuntimeManager } from "./tmux/runtime-manager.js";

export function openTmuxTargetFromCaller(target: CoreTmuxTarget): void {
  const tmux = new TmuxRuntimeManager();
  tmux.openTarget(target, { insideTmux: tmux.isInsideTmux(), alreadyResolved: true });
}
