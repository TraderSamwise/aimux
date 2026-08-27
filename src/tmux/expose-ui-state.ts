import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../atomic-write.js";
import type { ExposeSortMode } from "./expose-ordering.js";

const EXPOSE_UI_STATE_FILE = "expose-ui-state.json";

interface ExposeUiStateFile {
  version: 1;
  sortMode: ExposeSortMode;
}

export interface ExposeUiState {
  sortMode: ExposeSortMode;
}

export const DEFAULT_EXPOSE_UI_STATE: ExposeUiState = {
  sortMode: "default",
};

function exposeUiStatePath(projectStateDir: string): string {
  return join(projectStateDir, EXPOSE_UI_STATE_FILE);
}

function isExposeSortMode(value: unknown): value is ExposeSortMode {
  return value === "default" || value === "recent-output";
}

export function readExposeUiState(projectStateDir: string): ExposeUiState {
  try {
    const parsed = JSON.parse(readFileSync(exposeUiStatePath(projectStateDir), "utf8")) as Partial<ExposeUiStateFile>;
    if (!isExposeSortMode(parsed.sortMode)) return DEFAULT_EXPOSE_UI_STATE;
    return { sortMode: parsed.sortMode };
  } catch {
    return DEFAULT_EXPOSE_UI_STATE;
  }
}

export function writeExposeUiState(projectStateDir: string, state: ExposeUiState): void {
  writeJsonAtomic(exposeUiStatePath(projectStateDir), {
    version: 1,
    sortMode: state.sortMode,
  } satisfies ExposeUiStateFile);
}
