import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const aimuxTestHome = mkdtempSync(join(tmpdir(), "aimux-vitest-home-"));

process.env.AIMUX_HOME = aimuxTestHome;
process.env.AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS = "1";

afterAll(() => {
  rmSync(aimuxTestHome, { recursive: true, force: true });
});
