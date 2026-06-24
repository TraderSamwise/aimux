import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("tmux-statusline.sh", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length) {
      rmSync(tempRoots.pop()!, { recursive: true, force: true });
    }
  });

  it("logs missing cache files without showing status err", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-statusline-script-"));
    tempRoots.push(root);
    const script = join(process.cwd(), "scripts", "tmux-statusline.sh");

    const output = execFileSync(
      "sh",
      [
        script,
        "--line",
        "bottom",
        "--project-state-dir",
        root,
        "--current-window",
        "dashboard",
        "--current-session",
        "aimux-repo-client-live",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(output).not.toContain("status err");
    expect(output).toBe("\n");
    expect(readFileSync(join(root, "logs", "tmux-statusline.log"), "utf8")).toContain(
      "dashboard bottom render missing file",
    );
  });
});
