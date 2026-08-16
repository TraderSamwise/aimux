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

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

function rgbToCode({ r, g, b }: RgbColor): number {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

export function rgbFromWorktreeColorCode(code: number): RgbColor {
  return {
    r: (code >> 16) & 0xff,
    g: (code >> 8) & 0xff,
    b: code & 0xff,
  };
}

function mix32(value: number): number {
  let hash = value >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function boostedRgbFromHash(hash: number): RgbColor {
  let r = 80 + ((hash & 0xff) % 156);
  let g = 80 + (((hash >>> 8) & 0xff) % 156);
  let b = 80 + (((hash >>> 16) & 0xff) % 156);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 80) {
    if (max === r) r = Math.min(255, r + 70);
    else if (max === g) g = Math.min(255, g + 70);
    else b = Math.min(255, b + 70);

    if (min === r) r = Math.max(65, r - 45);
    else if (min === g) g = Math.max(65, g - 45);
    else b = Math.max(65, b - 45);
  }
  return { r, g, b };
}

export function worktreeColorCodeForKey(key: string | undefined, fallbackKey = "default"): number {
  const hash = mix32(stableStringHash(`aimux-worktree-color-rgb:v7490:${key ?? fallbackKey}`));
  return rgbToCode(boostedRgbFromHash(hash));
}

export function worktreeColorCode(input: WorktreeColorInput): number {
  return worktreeColorCodeForKey(worktreeColorKey(input));
}

export function worktreeColorHexForCode(code: number): string {
  const { r, g, b } = rgbFromWorktreeColorCode(code);
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function worktreeColorHex(input: WorktreeColorInput): string {
  return worktreeColorHexForCode(worktreeColorCode(input));
}

export function worktreeColorAnsiForCode(code: number): string {
  const { r, g, b } = rgbFromWorktreeColorCode(code);
  return `38;2;${r};${g};${b}`;
}

export function worktreeColorAnsi(input: WorktreeColorInput): string {
  return worktreeColorAnsiForCode(worktreeColorCode(input));
}
