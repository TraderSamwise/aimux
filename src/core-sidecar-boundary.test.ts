import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function listSourceFiles(dir: string): string[] {
  const root = new URL(".", import.meta.url).pathname;
  const current = join(root, dir);
  return readdirSync(current).flatMap((entry) => {
    const fullPath = join(current, entry);
    const relativePath = relative(root, fullPath);
    if (entry === "node_modules" || entry === "dist") return [];
    if (statSync(fullPath).isDirectory()) return listSourceFiles(relativePath);
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts") || entry.endsWith(".test.ts")) return [];
    return [relativePath];
  });
}

describe("core sidecar module boundary", () => {
  it("keeps daemon implementation separate from supervisor bootstrap helpers", () => {
    const daemonSource = source("./daemon.ts");
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

  it("keeps daemon HTTP transport separate from supervisor bootstrap", () => {
    const supervisorSource = source("./daemon-supervisor.ts");

    expect(supervisorSource).not.toContain("export async function requestDaemonJson");
    expect(source("./daemon-client.ts")).toContain("export async function requestDaemonJson");
  });

  it("keeps ordinary clients out of daemon supervisor lifecycle code", () => {
    const allowed = new Set(["core-command-client.ts", "daemon-supervisor.ts", "main.ts", "runtime-restart.ts"]);
    const offenders = listSourceFiles(".").filter((path) => {
      if (allowed.has(path)) return false;
      return source(`./${path}`).includes("daemon-supervisor.js");
    });

    expect(offenders).toEqual([]);
  });
});
