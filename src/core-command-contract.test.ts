import { describe, expect, it } from "vitest";
import { AimuxDaemon } from "./daemon.js";
import {
  CORE_API_ROUTES,
  CORE_COMMAND_NAMES,
  type CoreCommandOk,
  type CoreStatusResult,
} from "./core-command-contract.js";

describe("core command route", () => {
  it("answers daemon-local ping commands", async () => {
    const daemon = new AimuxDaemon();
    const result = await daemon.routeRequest("POST", CORE_API_ROUTES.commands, {
      id: "test-ping",
      command: CORE_COMMAND_NAMES.ping,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      id: "test-ping",
      command: CORE_COMMAND_NAMES.ping,
      result: { pong: true },
    });
  });

  it("returns the daemon status snapshot", async () => {
    const daemon = new AimuxDaemon();
    const result = await daemon.routeRequest("POST", CORE_API_ROUTES.commands, {
      id: "test-status",
      command: CORE_COMMAND_NAMES.status,
    });
    const body = result.body as CoreCommandOk<typeof CORE_COMMAND_NAMES.status>;
    expect(result.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.id).toBe("test-status");
    expect(body.command).toBe(CORE_COMMAND_NAMES.status);
    expect((body.result as CoreStatusResult).daemon.pid).toBe(process.pid);
    expect((body.result as CoreStatusResult).daemon.startedAt).toEqual(expect.any(String));
    expect((body.result as CoreStatusResult).daemon.updatedAt).toEqual(expect.any(String));
    expect(Array.isArray((body.result as CoreStatusResult).projects)).toBe(true);
    expect(body.result).toHaveProperty("relay");
    for (const project of (body.result as CoreStatusResult).projects) {
      expect(project).toHaveProperty("id");
      expect(project).toHaveProperty("name");
      expect(project).toHaveProperty("path");
      expect(project).toHaveProperty("dashboardSessionName");
      expect(project).toHaveProperty("serviceAlive");
      expect(project).toHaveProperty("serviceEndpoint");
    }
  });

  it("rejects unknown commands", async () => {
    const daemon = new AimuxDaemon();
    const result = await daemon.routeRequest("POST", CORE_API_ROUTES.commands, {
      id: "bad",
      command: "core.missing",
    });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      ok: false,
      id: "bad",
      command: "core.missing",
      error: "unknown core command",
    });
  });

  it.each([CORE_COMMAND_NAMES.projectEnsure, CORE_COMMAND_NAMES.projectStop, CORE_COMMAND_NAMES.projectKill])(
    "rejects %s without a projectRoot",
    async (command) => {
      const daemon = new AimuxDaemon();
      const result = await daemon.routeRequest("POST", CORE_API_ROUTES.commands, {
        id: "bad-project",
        command,
        payload: {},
      });
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        ok: false,
        id: "bad-project",
        command,
        error: "projectRoot is required",
      });
    },
  );
});
