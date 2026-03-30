import {
  claimSession,
  getRemoteInstances,
  registerInstance,
  unregisterInstance,
  updateHeartbeat,
  type InstanceInfo,
  type InstanceSessionRef,
} from "./instance-registry.js";
import { getRemoteOwnedSessionKeys } from "./dashboard-session-registry.js";

export interface SessionsFileEntry {
  id: string;
  tool: string;
  status: string;
  backendSessionId?: string;
  worktreePath?: string;
  instance?: string;
}

export interface InstanceDirectoryFns {
  getRemoteInstances?: (ownInstanceId: string, cwd: string) => InstanceInfo[];
  registerInstance?: (instanceId: string, cwd: string) => Promise<InstanceInfo[]>;
  unregisterInstance?: (instanceId: string, cwd: string) => Promise<void>;
  updateHeartbeat?: (instanceId: string, sessions: InstanceSessionRef[], cwd: string) => Promise<string[]>;
  claimSession?: (sessionId: string, fromInstanceId: string, cwd: string) => Promise<InstanceSessionRef | undefined>;
}

export class InstanceDirectory {
  constructor(private readonly fns: InstanceDirectoryFns = {}) {}

  getRemoteInstancesSafe(ownInstanceId: string, cwd: string): InstanceInfo[] {
    try {
      return (this.fns.getRemoteInstances ?? getRemoteInstances)(ownInstanceId, cwd);
    } catch {
      return [];
    }
  }

  async registerInstance(instanceId: string, cwd: string): Promise<InstanceInfo[]> {
    return (this.fns.registerInstance ?? registerInstance)(instanceId, cwd);
  }

  async unregisterInstance(instanceId: string, cwd: string): Promise<void> {
    return (this.fns.unregisterInstance ?? unregisterInstance)(instanceId, cwd);
  }

  getRemoteOwnedSessionKeys(ownInstanceId: string, cwd: string): Set<string> {
    return getRemoteOwnedSessionKeys(this.getRemoteInstancesSafe(ownInstanceId, cwd));
  }

  async updateHeartbeat(instanceId: string, sessions: InstanceSessionRef[], cwd: string): Promise<string[]> {
    return (this.fns.updateHeartbeat ?? updateHeartbeat)(instanceId, sessions, cwd);
  }

  async reconcileHeartbeat(
    instanceId: string,
    sessions: InstanceSessionRef[],
    cwd: string,
    confirmedRegistered: Set<string>,
  ): Promise<{ claimedIds: string[]; confirmedIds: Set<string>; skippedClaimDetection: boolean }> {
    const previousIds = await this.updateHeartbeat(instanceId, sessions, cwd);
    const nextConfirmed = new Set(confirmedRegistered);
    const claimedIds: string[] = [];
    let skippedClaimDetection = false;

    if (previousIds.length > 0 || confirmedRegistered.size === 0) {
      const previousSet = new Set(previousIds);
      for (const id of confirmedRegistered) {
        if (!previousSet.has(id)) {
          claimedIds.push(id);
          nextConfirmed.delete(id);
        }
      }
    } else if (confirmedRegistered.size > 0) {
      skippedClaimDetection = true;
    }

    for (const session of sessions) {
      nextConfirmed.add(session.id);
    }

    return {
      claimedIds,
      confirmedIds: nextConfirmed,
      skippedClaimDetection,
    };
  }

  async claimSession(sessionId: string, fromInstanceId: string, cwd: string): Promise<InstanceSessionRef | undefined> {
    return (this.fns.claimSession ?? claimSession)(sessionId, fromInstanceId, cwd);
  }

  buildSessionsFileEntries(localSessions: InstanceSessionRef[], remoteInstances: InstanceInfo[]): SessionsFileEntry[] {
    const data: SessionsFileEntry[] = localSessions.map((session) => ({
      id: session.id,
      tool: session.tool,
      status: "running",
      backendSessionId: session.backendSessionId,
      worktreePath: session.worktreePath,
    }));

    for (const inst of remoteInstances) {
      for (const session of inst.sessions) {
        if (data.some((entry) => entry.id === session.id)) continue;
        data.push({
          id: session.id,
          tool: session.tool,
          status: "running",
          backendSessionId: session.backendSessionId,
          worktreePath: session.worktreePath,
          instance: `PID ${inst.pid}`,
        });
      }
    }

    return data;
  }
}
