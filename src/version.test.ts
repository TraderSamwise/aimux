import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { readAimuxVersionFromPackageRoot } from "./version.js";

const tmpRoots: string[] = [];

function makePackageRoot(files: Record<string, string>): string {
  const root = join(tmpdir(), `aimux-version-${process.pid}-${tmpRoots.length}`);
  mkdirSync(root, { recursive: true });
  tmpRoots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents);
  }
  return root;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    rmSync(tmpRoots.pop()!, { recursive: true, force: true });
  }
});

describe("readAimuxVersionFromPackageRoot", () => {
  it("prefers the installed artifact VERSION label", () => {
    const root = makePackageRoot({
      VERSION: "local-c8abfdc6\n",
      "package.json": JSON.stringify({ version: "0.1.28" }),
    });

    expect(readAimuxVersionFromPackageRoot(root)).toBe("local-c8abfdc6");
  });

  it("falls back to package.json for source checkouts", () => {
    const root = makePackageRoot({
      "package.json": JSON.stringify({ version: "0.1.28" }),
    });

    expect(readAimuxVersionFromPackageRoot(root)).toBe("0.1.28");
  });

  it("falls back to 0.0.0 when no version source is readable", () => {
    const root = makePackageRoot({});

    expect(readAimuxVersionFromPackageRoot(root)).toBe("0.0.0");
  });
});
