import { describe, expect, it } from "vitest";
import {
  buildViewHref,
  detailHrefForPath,
  mergeViewParams,
  parentViewHrefForPath,
  projectPathFromSearch,
} from "./view-location";

describe("view location helpers", () => {
  it("reads the first project search value", () => {
    expect(projectPathFromSearch("/Users/sam/cs/aimux")).toBe("/Users/sam/cs/aimux");
    expect(projectPathFromSearch(["/a", "/b"])).toBe("/a");
    expect(projectPathFromSearch("  ")).toBeNull();
  });

  it("drops empty params when building hrefs", () => {
    expect(buildViewHref("/topology", { project: "/p", mode: "map", lens: "" })).toEqual({
      pathname: "/topology",
      params: { project: "/p", mode: "map" },
    });
  });

  it("merges current search params with explicit overrides", () => {
    expect(
      mergeViewParams(
        { project: "/old", mode: "map", lens: ["all"], section: undefined },
        { project: "/new", section: "queue" },
      ),
    ).toEqual({
      project: "/new",
      mode: "map",
      lens: "all",
      section: "queue",
      document: null,
    });
  });

  it("builds stack-local detail hrefs for the current tab", () => {
    expect(detailHrefForPath("/topology", "agent", "claude-1", "/p")).toEqual({
      pathname: "/topology/agent/claude-1/chat",
      params: { project: "/p" },
    });
    expect(detailHrefForPath("/notifications", "service", "svc/1", "/p")).toEqual({
      pathname: "/notifications/service/svc%2F1",
      params: { project: "/p" },
    });
    expect(detailHrefForPath("/", "agent", "claude-1", "/p")).toEqual({
      pathname: "/agent/claude-1/chat",
      params: { project: "/p" },
    });
  });

  it("builds parent hrefs for stack-local fallback back navigation", () => {
    expect(parentViewHrefForPath("/topology/agent/claude-1/chat", "/p")).toEqual({
      pathname: "/topology",
      params: { project: "/p" },
    });
    expect(parentViewHrefForPath("/agent/claude-1/chat", "/p")).toEqual({
      pathname: "/",
      params: { project: "/p" },
    });
  });
});
