export function exposePreviewFooterCropRows(visibleLineCount: number): number {
  if (visibleLineCount <= 0) return 0;
  if (visibleLineCount <= 8) return 3;
  if (visibleLineCount <= 11) return 2;
  if (visibleLineCount <= 14) return 1;
  return 0;
}

export function cropExposePreviewFooter<T>(lines: readonly T[], visibleLineCount: number): T[] {
  const count = Math.max(0, Math.floor(visibleLineCount));
  if (count === 0) return [];
  const desiredDrop = exposePreviewFooterCropRows(count);
  const drop = Math.min(desiredDrop, Math.max(0, lines.length - count));
  const source = drop > 0 ? lines.slice(0, lines.length - drop) : lines;
  return source.slice(-count);
}
