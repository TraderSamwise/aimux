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

function hueToRgb(p: number, q: number, t: number): number {
  let next = t;
  if (next < 0) next += 1;
  if (next > 1) next -= 1;
  if (next < 1 / 6) return p + (q - p) * 6 * next;
  if (next < 1 / 2) return q;
  if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
  return p;
}

function hslToRgb(hue: number, saturation: number, lightness: number): RgbColor {
  const h = ((hue % 360) + 360) / 360;
  const s = Math.max(0, Math.min(100, saturation)) / 100;
  const l = Math.max(0, Math.min(100, lightness)) / 100;
  if (s === 0) {
    const value = Math.round(l * 255);
    return { r: value, g: value, b: value };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, h) * 255),
    b: Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
  };
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

export function worktreeColorCodeForKey(key: string | undefined, fallbackKey = "default"): number {
  const hash = stableStringHash(key ?? fallbackKey);
  const hue = hash % 360;
  const saturation = 62 + ((hash >>> 9) % 19);
  const lightness = 56 + ((hash >>> 14) % 11);
  return rgbToCode(hslToRgb(hue, saturation, lightness));
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
