import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getGlobalAimuxDir, getLocalAimuxDir, getProjectId, getRepoRoot } from "./paths.js";
import {
  updateSessionMetadata,
  clearSessionLogs,
  type MetadataTone,
  type MetadataApiEndpoint,
  type SessionContextMetadata,
} from "./metadata-store.js";
import { debug } from "./debug.js";
import { createBuiltinMetadataWatchers } from "./builtin-metadata-watchers.js";
import { AgentTracker } from "./agent-tracker.js";
import type { AgentActivityState, AgentAttentionState, AgentEvent } from "./agent-events.js";
import { createToolOutputWatcher } from "./tool-output-watchers.js";

export interface AimuxMetadataAPI {
  setStatus(session: string, text: string, tone?: MetadataTone): void;
  setProgress(session: string, current: number, total: number, label?: string): void;
  log(session: string, message: string, opts?: { source?: string; tone?: MetadataTone }): void;
  clearLog(session: string): void;
  setContext(session: string, context: SessionContextMetadata): void;
  emitEvent(session: string, event: AgentEvent): void;
  markSeen(session: string): void;
  setActivity(session: string, activity: AgentActivityState): void;
  setAttention(session: string, attention: AgentAttentionState): void;
}

export interface AimuxPluginAPI {
  projectRoot: string;
  projectId: string;
  serverHost: string;
  serverPort: number;
  metadata: AimuxMetadataAPI;
}

export interface AimuxPluginInstance {
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

type AimuxPluginFactory = (api: AimuxPluginAPI) => void | AimuxPluginInstance | Promise<void | AimuxPluginInstance>;

function listPluginFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".js") || entry.endsWith(".mjs"))
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isFile());
}

export class PluginRuntime {
  private instances: AimuxPluginInstance[] = [];

  constructor(private readonly endpoint: MetadataApiEndpoint) {}

  async start(): Promise<void> {
    const tracker = new AgentTracker();
    const api: AimuxPluginAPI = {
      projectRoot: getRepoRoot(),
      projectId: getProjectId(),
      serverHost: this.endpoint.host,
      serverPort: this.endpoint.port,
      metadata: {
        setStatus: (session, text, tone) => {
          updateSessionMetadata(session, (current) => ({
            ...current,
            status: { text, tone },
          }));
        },
        setProgress: (session, current, total, label) => {
          updateSessionMetadata(session, (existing) => ({
            ...existing,
            progress: { current, total, label },
          }));
        },
        log: (session, message, opts) => {
          updateSessionMetadata(session, (existing) => ({
            ...existing,
            logs: [
              ...(existing.logs ?? []).slice(-19),
              { message, source: opts?.source, tone: opts?.tone, ts: new Date().toISOString() },
            ],
          }));
        },
        clearLog: (session) => {
          clearSessionLogs(session);
        },
        setContext: (session, context) => {
          updateSessionMetadata(session, (existing) => ({
            ...existing,
            context: {
              ...(existing.context ?? {}),
              ...context,
            },
          }));
        },
        emitEvent: (session, event) => {
          tracker.emit(session, event);
        },
        markSeen: (session) => {
          tracker.markSeen(session);
        },
        setActivity: (session, activity) => {
          tracker.setActivity(session, activity);
        },
        setAttention: (session, attention) => {
          tracker.setAttention(session, attention);
        },
      },
    };

    for (const watcher of createBuiltinMetadataWatchers(api)) {
      if (watcher.start) await watcher.start();
      this.instances.push(watcher);
    }

    const outputWatcher = createToolOutputWatcher({ api });
    if (outputWatcher.start) await outputWatcher.start();
    this.instances.push(outputWatcher);

    const pluginFiles = [
      ...listPluginFiles(join(getGlobalAimuxDir(), "plugins")),
      ...listPluginFiles(join(getLocalAimuxDir(), "plugins")),
    ];
    for (const file of pluginFiles) {
      try {
        const mod = (await import(pathToFileURL(file).href)) as { default?: AimuxPluginFactory };
        if (typeof mod.default !== "function") continue;
        const instance = await mod.default(api);
        if (instance?.start) await instance.start();
        if (instance) this.instances.push(instance);
        debug(`loaded plugin ${file}`, "plugin");
      } catch (error) {
        debug(`failed plugin ${file}: ${error instanceof Error ? error.message : String(error)}`, "plugin");
      }
    }
  }

  async stop(): Promise<void> {
    for (const instance of this.instances.reverse()) {
      try {
        await instance.stop?.();
      } catch (error) {
        debug(`plugin stop failed: ${error instanceof Error ? error.message : String(error)}`, "plugin");
      }
    }
    this.instances = [];
  }
}
