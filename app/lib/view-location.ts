import type { Href } from "expo-router";

export type SearchValue = string | string[] | undefined;

export interface AimuxViewParams {
  project?: string | null;
  mode?: string | null;
  lens?: string | null;
  section?: string | null;
  document?: string | null;
}

export function firstSearchValue(value: SearchValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function cleanSearchValue(value: SearchValue): string | null {
  const first = firstSearchValue(value);
  if (!first) return null;
  const trimmed = first.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function projectPathFromSearch(value: SearchValue): string | null {
  return cleanSearchValue(value);
}

export function buildViewHref(pathname: string, params: AimuxViewParams = {}): Href {
  const cleanParams = Object.fromEntries(
    Object.entries(params).filter((entry): entry is [string, string] => {
      const value = entry[1];
      return typeof value === "string" && value.trim().length > 0;
    }),
  );
  return { pathname, params: cleanParams } as Href;
}

export function mergeViewParams(
  current: Record<string, SearchValue>,
  next: AimuxViewParams,
): AimuxViewParams {
  return {
    project: next.project ?? projectPathFromSearch(current.project),
    mode: next.mode ?? cleanSearchValue(current.mode),
    lens: next.lens ?? cleanSearchValue(current.lens),
    section: next.section ?? cleanSearchValue(current.section),
    document: next.document ?? cleanSearchValue(current.document),
  };
}
