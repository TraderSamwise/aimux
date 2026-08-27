import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_EXPOSE_UI_STATE, readExposeUiState, writeExposeUiState } from "./expose-ui-state.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function createStateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "aimux-expose-ui-state-test-"));
  tempRoots.push(root);
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  return stateDir;
}

describe("expose ui state", () => {
  it("defaults when the state file is missing or invalid", () => {
    const stateDir = createStateDir();
    expect(readExposeUiState(stateDir)).toEqual(DEFAULT_EXPOSE_UI_STATE);

    writeFileSync(join(stateDir, "expose-ui-state.json"), JSON.stringify({ version: 1, sortMode: "unknown" }));
    expect(readExposeUiState(stateDir)).toEqual(DEFAULT_EXPOSE_UI_STATE);
  });

  it("persists the selected sort mode", () => {
    const stateDir = createStateDir();

    writeExposeUiState(stateDir, { sortMode: "recent-output" });

    expect(readExposeUiState(stateDir)).toEqual({ sortMode: "recent-output" });
  });
});
