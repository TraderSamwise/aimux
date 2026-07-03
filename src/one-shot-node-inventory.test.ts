import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const runtimeNodeSpawnInventory = [
  { id: "bin-shim", path: "bin/aimux", pattern: /node/ },
  { id: "release-shim", path: "scripts/install.sh", pattern: /AIMUX_NODE_BIN[\s\S]*dist\/main\.js/ },
  { id: "release-expose-shim", path: "scripts/install.sh", pattern: /popup-expose\.js/ },
  { id: "tmux-switcher", path: "scripts/tmux-control.sh", pattern: /switcher/ },
  { id: "tmux-expose", path: "scripts/tmux-control.sh", pattern: /expose/ },
  { id: "tmux-meta-dashboard", path: "scripts/tmux-control.sh", pattern: /meta-dashboard/ },
  { id: "tmux-dashboard-reload", path: "scripts/tmux-control.sh", pattern: /dashboard-reload/ },
  { id: "tmux-hyperlink-node", path: "scripts/tmux-open-hyperlink.sh", pattern: /node - <<'NODE'/ },
  { id: "dashboard-repair", path: "src/multiplexer/dashboard-control.ts", pattern: /"restart", "--project"/ },
] as const;

describe("one-shot Node runtime inventory", () => {
  it("keeps every remaining violation explicit for the Core cutover", () => {
    expect(runtimeNodeSpawnInventory).toHaveLength(9);
    for (const entry of runtimeNodeSpawnInventory) {
      const text = readFileSync(join(process.cwd(), entry.path), "utf8");
      expect(text, entry.id).toMatch(entry.pattern);
    }
  });
});
