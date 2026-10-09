import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAYOUT = "app/(main)/_layout.tsx";

// Source rather than render: this layout is 500 lines with a dozen effects and
// no renderer in this app runs one. The decision it makes is tested next door;
// this pins only that the layout asks for it and holds no copy of its own.
describe("the layout's shared-chat redirect", () => {
  const path = join(APP_ROOT, LAYOUT);
  const source = (() => {
    expect(existsSync(path), `${path} is readable`).toBe(true);
    return readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "");
  })();

  it("asks the shared helper where to go", () => {
    expect(source).toContain("sharedChatRedirect(activeShare, pathname)");
    expect(source, "and acts on the answer").toMatch(
      /sharedChatRedirect\(activeShare, pathname\)[\s\S]{0,120}?router\.replace\(/,
    );
  });

  it("holds no second copy of the rule", () => {
    expect(source, "the share-route exemption belongs in the helper").not.toMatch(
      /pathname\.startsWith\("\/shares\/"\)/,
    );
    expect(source, "and so does building the href").not.toContain("sharedChatHref(");
  });
});
