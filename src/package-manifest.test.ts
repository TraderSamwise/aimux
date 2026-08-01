import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("package manifest", () => {
  it("ships runtime scripts required by installed npm binaries", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      files?: string[];
    };

    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        "scripts/installed-aimux-shim.sh",
        "scripts/tmux-control.sh",
        "scripts/tmux-open-hyperlink.sh",
        "scripts/tmux-statusline.sh",
      ]),
    );
  });
});
