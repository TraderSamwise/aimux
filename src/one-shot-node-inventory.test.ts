import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cliBootstrapInventory = [
  { id: "bin-shim", path: "bin/aimux", pattern: /node/ },
  { id: "release-shim", path: "scripts/install.sh", pattern: /AIMUX_NODE_BIN[\s\S]*dist\/main\.js/ },
] as const;

const forbiddenRuntimeNodeSpawns = [
  { id: "tmux-hyperlink-node", path: "scripts/tmux-open-hyperlink.sh", pattern: /node - <<'NODE'/ },
  { id: "dashboard-repair", path: "src/multiplexer/dashboard-control.ts", pattern: /"restart", "--project"/ },
] as const;

describe("one-shot Node runtime inventory", () => {
  it("keeps the Node CLI bootstrap explicit", () => {
    expect(cliBootstrapInventory).toHaveLength(2);
    for (const entry of cliBootstrapInventory) {
      const text = readFileSync(join(process.cwd(), entry.path), "utf8");
      expect(text, entry.id).toMatch(entry.pattern);
    }
  });

  it("does not spawn one-shot Node from runtime repair or tmux helpers", () => {
    expect(forbiddenRuntimeNodeSpawns).toHaveLength(2);
    for (const entry of forbiddenRuntimeNodeSpawns) {
      const text = readFileSync(join(process.cwd(), entry.path), "utf8");
      expect(text, entry.id).not.toMatch(entry.pattern);
    }
  });
});
