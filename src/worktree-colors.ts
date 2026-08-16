export const WORKTREE_COLOR_PALETTE = [
  { hex: "#00afd7", xterm: "38;5;38" },
  { hex: "#5faf5f", xterm: "38;5;71" },
  { hex: "#d7af5f", xterm: "38;5;179" },
  { hex: "#d787d7", xterm: "38;5;176" },
  { hex: "#5fafff", xterm: "38;5;75" },
  { hex: "#ff875f", xterm: "38;5;209" },
] as const;

export const WORKTREE_COLOR_HEXES = WORKTREE_COLOR_PALETTE.map((tone) => tone.hex);
export const WORKTREE_COLOR_XTERM_CODES = WORKTREE_COLOR_PALETTE.map((tone) => tone.xterm);

export interface WorktreeColorInput {
  path?: string | null;
  projectRoot?: string | null;
  name?: string | null;
  projectName?: string | null;
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\\/g, "/").replace(/\/+/g, "/") : undefined;
}

export function worktreeColorKey(input: WorktreeColorInput): string | undefined {
  const path = clean(input.path);
  if (path) return `path:${path}`;
  const projectRoot = clean(input.projectRoot);
  const name = clean(input.name);
  if (projectRoot && name) return `project-root:${projectRoot}\0name:${name}`;
  if (name) return `name:${name}`;
  const projectName = clean(input.projectName);
  if (projectRoot) return `project-root:${projectRoot}`;
  if (projectName) return `project:${projectName}`;
  return undefined;
}

export function stableStringHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function worktreeColorIndexForKey(key: string | undefined, fallbackIndex = 0): number {
  const size = WORKTREE_COLOR_PALETTE.length;
  if (!key) return ((fallbackIndex % size) + size) % size;
  return stableStringHash(key) % size;
}

export function worktreeColorIndex(input: WorktreeColorInput, fallbackIndex = 0): number {
  return worktreeColorIndexForKey(worktreeColorKey(input), fallbackIndex);
}

export function worktreeColorHex(input: WorktreeColorInput, fallbackIndex = 0): string {
  return WORKTREE_COLOR_HEXES[worktreeColorIndex(input, fallbackIndex)]!;
}

export function worktreeColorXterm(input: WorktreeColorInput, fallbackIndex = 0): string {
  return WORKTREE_COLOR_XTERM_CODES[worktreeColorIndex(input, fallbackIndex)]!;
}
