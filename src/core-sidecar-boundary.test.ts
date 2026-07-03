import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("core sidecar module boundary", () => {
  it("keeps daemon implementation separate from supervisor bootstrap helpers", () => {
    const daemonSource = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
    const forbidden = [
      'from "./daemon-supervisor.js"',
      "export async function ensureDaemonRunning",
      "export async function stopDaemon",
      "export async function requestDaemonJson",
      "export async function ensureProjectService",
      "export async function stopProjectService",
      "export async function projectServiceStatus",
    ];

    for (const pattern of forbidden) {
      expect(daemonSource).not.toContain(pattern);
    }
  });
});
