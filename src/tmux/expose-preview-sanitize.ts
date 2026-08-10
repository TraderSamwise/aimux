// Keep SGR color/style sequences from captured agent output so previews render in
// their real colors, but strip everything else dangerous (cursor moves, OSC, other
// control bytes) so a rogue pane can't hijack the host terminal or misalign borders.
export function sanitizeExposePreviewLine(line: string): string {
  return line
    .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, (m) => (/^\x1b\[[0-9;:]*m$/.test(m) ? m : ""))
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;:?]*[ -/]*$/g, "")
    .replace(/\x1b[^[]/g, "")
    .replace(/\x1b$/, "")
    .replace(/[\x00-\x09\x0b-\x1a\x1c-\x1f\x7f-\x9f]/g, " ");
}

export function sanitizeExposePreviewOutput(raw: string): string[] {
  const lines = raw.replace(/\r/g, "").split("\n").map(sanitizeExposePreviewLine);
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}
