import type { Href } from "expo-router";

export type SearchValue = string | string[] | undefined;

export interface AimuxViewParams {
  project?: string | null;
  mode?: string | null;
  lens?: string | null;
  section?: string | null;
  document?: string | null;
  threadId?: string | null;
}

export type DetailRouteKind = "agent" | "service";

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

export function projectPathFromSearchOrLocation(value: SearchValue): string | null {
  return projectPathFromSearch(value) ?? projectPathFromBrowserLocation();
}

function projectPathFromBrowserLocation(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return projectPathFromSearch(
      new URLSearchParams(window.location.search).get("project") ?? undefined,
    );
  } catch {
    return null;
  }
}

export function buildViewHref(pathname: string, params: AimuxViewParams = {}): Href {
  return buildViewPath(pathname, params);
}

export function buildViewPath(pathname: string, params: AimuxViewParams = {}): Href {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.trim().length > 0) {
      query.set(key, value);
    }
  }
  const search = query.toString();
  return `${pathname}${search ? `?${search}` : ""}` as Href;
}

export function mergeViewParams(
  current: Record<string, SearchValue>,
  next: AimuxViewParams,
): AimuxViewParams {
  return {
    project: next.project !== undefined ? next.project : projectPathFromSearch(current.project),
    mode: next.mode !== undefined ? next.mode : cleanSearchValue(current.mode),
    lens: next.lens !== undefined ? next.lens : cleanSearchValue(current.lens),
    section: next.section !== undefined ? next.section : cleanSearchValue(current.section),
    document: next.document !== undefined ? next.document : cleanSearchValue(current.document),
    threadId: next.threadId !== undefined ? next.threadId : cleanSearchValue(current.threadId),
  };
}

export function detailHrefForPath(
  pathname: string,
  kind: "agent",
  id: string,
  projectPath?: string | null,
): Href;
export function detailHrefForPath(
  pathname: string,
  kind: "service",
  id: string,
  projectPath?: string | null,
): Href;
export function detailHrefForPath(
  pathname: string,
  kind: DetailRouteKind,
  id: string,
  projectPath?: string | null,
): Href {
  const tabPrefix = detailTabPrefix(pathname);
  const detailPath =
    kind === "agent" ? `${tabPrefix}/agent/[sessionId]/chat` : `${tabPrefix}/service/[serviceId]`;
  const routeParam = kind === "agent" ? { sessionId: id } : { serviceId: id };
  return buildViewHrefObject(detailPath, { ...routeParam, project: projectPath });
}

function buildViewHrefObject(pathname: string, params: Record<string, string | null | undefined>) {
  const cleanParams = Object.fromEntries(
    Object.entries(params).filter((entry): entry is [string, string] => {
      const value = entry[1];
      return typeof value === "string" && value.trim().length > 0;
    }),
  );
  return { pathname, params: cleanParams } as Href;
}

function detailTabPrefix(pathname: string): string {
  if (pathname.startsWith("/coordination")) return "/coordination";
  if (pathname.startsWith("/topology")) return "/topology";
  if (pathname.startsWith("/project")) return "/project";
  if (pathname.startsWith("/library")) return "/library";
  if (pathname.startsWith("/notifications")) return "/notifications";
  return "";
}

export function parentViewHrefForPath(pathname: string, projectPath?: string | null): Href {
  const prefix = detailTabPrefix(pathname);
  return buildViewHref(prefix || "/", { project: projectPath });
}
