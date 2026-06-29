import { describe, expect, it } from "vitest";
import {
  buildViewHref,
  buildViewPath,
  detailHrefForPath,
  detailViewPathForPath,
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
    expect(buildViewHref("/topology", { project: "/p", mode: "map", lens: "" })).toBe(
      "/topology?project=%2Fp&mode=map",
    );
  });

  it("builds encoded web paths for imperative tab navigation", () => {
    expect(buildViewPath("/notifications", { project: "/Users/sam/cs/aimux", lens: "" })).toBe(
      "/notifications?project=%2FUsers%2Fsam%2Fcs%2Faimux",
    );
    expect(buildViewPath("/global-notifications", { project: null })).toBe("/global-notifications");
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
      threadId: null,
    });
  });

  it("builds stack-local detail hrefs for the current tab", () => {
    expect(detailHrefForPath("/topology", "agent", "claude-1", "/p")).toEqual({
      pathname: "/topology/agent/[sessionId]/chat",
      params: { sessionId: "claude-1", project: "/p" },
    });
    expect(detailHrefForPath("/notifications", "service", "svc/1", "/p")).toEqual({
      pathname: "/notifications/service/[serviceId]",
      params: { serviceId: "svc/1", project: "/p" },
    });
    expect(detailHrefForPath("/", "agent", "claude-1", "/p")).toEqual({
      pathname: "/agent/[sessionId]/chat",
      params: { sessionId: "claude-1", project: "/p" },
    });
  });

  it("builds encoded detail web paths for hard navigation", () => {
    expect(detailViewPathForPath("/project", "agent", "claude/1", "/p")).toBe(
      "/project/agent/claude%2F1/chat?project=%2Fp",
    );
    expect(detailViewPathForPath("/notifications", "service", "svc/1", "/p")).toBe(
      "/notifications/service/svc%2F1?project=%2Fp",
    );
  });

  it("builds parent hrefs for stack-local fallback back navigation", () => {
    expect(parentViewHrefForPath("/topology/agent/claude-1/chat", "/p")).toBe(
      "/topology?project=%2Fp",
    );
    expect(parentViewHrefForPath("/agent/claude-1/chat", "/p")).toBe("/?project=%2Fp");
  });
});
