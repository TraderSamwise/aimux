import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listLibraryDocuments } from "./library-documents.js";

describe("listLibraryDocuments", () => {
  it("returns the allowed project documents with bounded content", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-library-docs-"));
    writeFileSync(join(dir, "AGENTS.md"), "repo instructions");
    writeFileSync(join(dir, "config.json"), "hidden");
    writeFileSync(join(dir, "README.md"), "x".repeat(40_001));

    const documents = listLibraryDocuments(dir);

    expect(documents.map((document) => document.id)).toEqual(["AGENTS.md", "README.md"]);
    expect(documents[0]).toMatchObject({
      id: "AGENTS.md",
      title: "AGENTS.md",
      path: "AGENTS.md",
      kind: "instructions",
      content: "repo instructions",
      truncated: false,
    });
    expect(documents[1]?.content).toHaveLength(40_000);
    expect(documents[1]?.truncated).toBe(true);
  });
});
