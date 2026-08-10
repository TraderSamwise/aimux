import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logLifecycleAlways } from "./debug.js";
import { getDaemonLogPath } from "./paths.js";

let home: string | null = null;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.AIMUX_HOME;
  home = mkdtempSync(join(tmpdir(), "aimux-lifecycle-log-"));
  process.env.AIMUX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.AIMUX_HOME;
  else process.env.AIMUX_HOME = previousHome;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

function lastRecord(): Record<string, never> {
  return JSON.parse(readFileSync(getDaemonLogPath(), "utf8").trim().split("\n").at(-1)!);
}

describe("logLifecycleAlways", () => {
  it("writes even though logging is off, which ordinary log calls do not", () => {
    // Logging defaults to disabled. The processes that request a restart are
    // short-lived CLI and dashboard processes with it off, so the line naming who
    // asked was never written, and the daemon log showed a restart with no cause.
    logLifecycleAlways("control plane restart requested", "daemon", { reason: "cli", pid: 1234 });

    expect(existsSync(getDaemonLogPath())).toBe(true);
    const record = lastRecord() as unknown as {
      message: string;
      category: string;
      pid: number;
      fields: { reason: string };
    };
    expect(record.message).toBe("control plane restart requested");
    expect(record.category).toBe("daemon");
    expect(record.fields.reason).toBe("cli");
    expect(record.pid).toBe(process.pid);
  });

  it("lands in the daemon log, where the restart it explains appears", () => {
    logLifecycleAlways("control plane restart requested", "daemon", {});
    expect(getDaemonLogPath()).toContain("daemon");
    expect(existsSync(getDaemonLogPath())).toBe(true);
  });

  it("redacts sensitive fields like every other record", () => {
    logLifecycleAlways("control plane restart requested", "daemon", { token: "secret-value" });
    const record = lastRecord() as unknown as { fields: { token: string } };
    expect(record.fields.token).toBe("<redacted>");
  });
});
