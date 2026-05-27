import { describe, expect, it } from "vitest";
import { buildViewHref, mergeViewParams, projectPathFromSearch } from "./view-location";

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
});
