import { describe, expect, it } from "vitest";
import {
  monitorSessionTargetsForProject,
  monitorSharedTargets,
  monitorTargetLabel,
  resolveMonitorTarget,
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
    { id: "scribe-1", status: "running", label: "Scribe", scribe: true },
    { id: "dead-1", status: "exited", label: "Dead" },
  ],
  services: [],
  worktrees: [],
};

describe("monitor targets", () => {
  it("lists only active non-control project sessions", () => {
    expect(monitorSessionTargetsForProject(project, state)).toEqual([
      {
        kind: "project-agent",
        id: "project::/repo/aimux:claude-1",
        projectPath: "/repo/aimux",
        machineId: undefined,
        projectName: "aimux",
        sessionId: "claude-1",
        sessionLabel: "Claude",
        status: "running",
        endpoint: { host: "127.0.0.1", port: 43192 },
      },
    ]);
  });

  it("collapses generated agent labels in monitor presentation labels", () => {
    const generatedState: DesktopState = {
      ...state,
      sessions: [
        {
          id: "codex-o6o4kf",
          status: "running",
          label: "codex-o6o4kf",
          command: "codex --model gpt-5.5",
          role: "coder",
        },
      ],
    };

    expect(monitorSessionTargetsForProject(project, generatedState)[0]).toMatchObject({
      sessionId: "codex-o6o4kf",
      sessionLabel: "codex",
    });
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
      cameraViewport: {
        centerX: 0.5,
        centerY: 0.5,
        zoom: 1,
      },
      speechToText: true,
      speechOnDeviceOnly: true,
      speechInterimResults: true,
      speechLanguage: "en-US",
      audioSampleRate: 16000,
      projectPath: "/repo/aimux",
      machineId: null,
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
        machineId: null,
        sessionId: "claude-2",
        shareOwnerUserId: "owner-1",
        shareId: "share-1",
      }),
    ).toBe(true);
  });
});

describe("two machines holding the same checkout", () => {
  const onMachine = (machineId: string): DaemonProject => ({
    ...project,
    machineId,
    machineName: `sam-${machineId}`,
  });

  // The same path and session id on two hosts gave two targets one id, so a
  // saved setting for one matched the other and the monitor streamed the
  // wrong host.
  it("gives their targets different ids", () => {
    expect(monitorSessionTargetsForProject(onMachine("mbp"), state)[0].id).not.toBe(
      monitorSessionTargetsForProject(onMachine("strix"), state)[0].id,
    );
  });

  it("matches a saved setting only on the machine it named", () => {
    const target = monitorSessionTargetsForProject(onMachine("mbp"), state)[0];
    const settingsFor = (machineId: string | null): MonitorSettings => ({
      intervalSeconds: 10,
      targetKind: "project-agent",
      captureMode: "camera",
      cameraViewport: { centerX: 0.5, centerY: 0.5, zoom: 1 },
      speechToText: false,
      speechOnDeviceOnly: false,
      speechInterimResults: false,
      speechLanguage: "en-US",
      audioSampleRate: 16000,
      projectPath: target.projectPath,
      machineId,
      sessionId: "claude-1",
      shareOwnerUserId: null,
      shareId: null,
    });

    expect(targetMatchesSettings(target, settingsFor("mbp"))).toBe(true);
    expect(targetMatchesSettings(target, settingsFor("strix"))).toBe(false);
    // Saved before machines existed: it matches the project wherever it is.
    expect(targetMatchesSettings(target, settingsFor(null))).toBe(true);
  });
});

describe("resolving a saved monitor setting to one target", () => {
  const onMachine = (machineId: string): DaemonProject => ({
    ...project,
    machineId,
    machineName: `sam-${machineId}`,
  });
  const targets = [
    ...monitorSessionTargetsForProject(onMachine("mbp"), state),
    ...monitorSessionTargetsForProject(onMachine("strix"), state),
  ];
  const settingsFor = (machineId: string | null): MonitorSettings => ({
    intervalSeconds: 10,
    targetKind: "project-agent",
    captureMode: "camera",
    cameraViewport: { centerX: 0.5, centerY: 0.5, zoom: 1 },
    speechToText: false,
    speechOnDeviceOnly: false,
    speechInterimResults: false,
    speechLanguage: "en-US",
    audioSampleRate: 16000,
    projectPath: "/repo/aimux",
    machineId,
    sessionId: "claude-1",
    shareOwnerUserId: null,
    shareId: null,
  });

  it("resolves a setting that names its machine", () => {
    expect(resolveMonitorTarget(targets, settingsFor("strix"))).toMatchObject({
      machineId: "strix",
    });
  });

  // Monitor types dictated speech into whatever this resolves to. Taking the
  // first match sent it to whichever host sorted first, while both rows
  // rendered identically -- so the wrong agent was typed into, invisibly.
  it("resolves a machineless setting to nothing when two machines hold the project", () => {
    expect(resolveMonitorTarget(targets, settingsFor(null))).toBeNull();
  });

  // One machine is unambiguous, so every setting saved before machines existed
  // keeps working.
  it("still resolves a machineless setting when only one machine has it", () => {
    const onlyMbp = monitorSessionTargetsForProject(onMachine("mbp"), state);
    expect(resolveMonitorTarget(onlyMbp, settingsFor(null))).toMatchObject({
      machineId: "mbp",
    });
  });

  // Having to choose is no use if the choices read the same.
  it("names the host in the label so the two rows differ", () => {
    expect(monitorTargetLabel(targets[0])).not.toBe(monitorTargetLabel(targets[1]));
    expect(monitorTargetLabel(targets[0])).toContain("sam-mbp");
  });
});
