import { describe, expect, it } from "vitest";
import {
  monitorSessionTargetsForProject,
  monitorSharedTargets,
  targetMatchesSettings,
} from "@/lib/monitor-targets";
import type { DaemonProject } from "@/lib/api";
import type { DesktopState } from "@/lib/desktop-state";
import type { MonitorSettings } from "@/stores/settings";

const project: DaemonProject = {
  id: "project-1",
  name: "aimux",
  path: "/repo/aimux",
  dashboardSessionName: "aimux",
  service: null,
  serviceAlive: true,
  serviceEndpoint: { host: "127.0.0.1", port: 43192 },
};

const state: DesktopState = {
  ok: true,
  sessions: [
    { id: "claude-1", status: "running", label: "Claude" },
    { id: "overseer-1", status: "running", label: "Overseer", overseer: true },
    { id: "dead-1", status: "exited", label: "Dead" },
  ],
  services: [],
  worktrees: [],
};

describe("monitor targets", () => {
  it("lists only active non-overseer project sessions", () => {
    expect(monitorSessionTargetsForProject(project, state)).toEqual([
      {
        kind: "project-agent",
        id: "project:/repo/aimux:claude-1",
        projectPath: "/repo/aimux",
        projectName: "aimux",
        sessionId: "claude-1",
        sessionLabel: "Claude",
        status: "running",
        endpoint: { host: "127.0.0.1", port: 43192 },
      },
    ]);
  });

  it("does not expose project sessions while the host service is unavailable", () => {
    expect(monitorSessionTargetsForProject({ ...project, serviceAlive: false }, state)).toEqual([]);
  });

  it("matches persisted project and shared target selections", () => {
    const [target] = monitorSessionTargetsForProject(project, state);
    const settings: MonitorSettings = {
      intervalSeconds: 10,
      targetKind: "project-agent",
      captureMode: "camera",
      speechToText: true,
      speechOnDeviceOnly: true,
      speechInterimResults: true,
      speechLanguage: "en-US",
      audioSampleRate: 16000,
      projectPath: "/repo/aimux",
      sessionId: "claude-1",
      shareOwnerUserId: null,
      shareId: null,
    };
    expect(targetMatchesSettings(target!, settings)).toBe(true);

    const [shared] = monitorSharedTargets([
      {
        shareId: "share-1",
        ownerUserId: "owner-1",
        projectRoot: "/repo/scratch",
        sessionId: "claude-2",
        serviceEndpoint: { host: "relay", port: 443 },
        acceptedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    expect(
      targetMatchesSettings(shared!, {
        ...settings,
        targetKind: "shared-chat",
        projectPath: "/repo/scratch",
        sessionId: "claude-2",
        shareOwnerUserId: "owner-1",
        shareId: "share-1",
      }),
    ).toBe(true);
  });
});
