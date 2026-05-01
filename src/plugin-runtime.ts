import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getGlobalAimuxDir, getLocalAimuxDir, getProjectId, getRepoRoot } from "./paths.js";
import {
  updateSessionMetadata,
  clearSessionLogs,
  loadMetadataState,
  type MetadataTone,
  type MetadataApiEndpoint,
  type SessionContextMetadata,
  type SessionServiceMetadata,
  type SessionStatuslineSegment,
} from "./metadata-store.js";
import { debug } from "./debug.js";
import { createBuiltinMetadataWatchers } from "./builtin-metadata-watchers.js";
import { AgentTracker } from "./agent-tracker.js";
import type { AgentActivityState, AgentAttentionState, AgentEvent } from "./agent-events.js";
import { type AlertKind, type ProjectEventBus } from "./project-events.js";

export interface AimuxMetadataAPI {
  setStatus(session: string, text: string, tone?: MetadataTone): void;
  setProgress(session: string, current: number, total: number, label?: string): void;
  log(session: string, message: string, opts?: { source?: string; tone?: MetadataTone }): void;
  clearLog(session: string): void;
  setContext(session: string, context: SessionContextMetadata): void;
  setStatuslineSegment(session: string, line: "top" | "bottom", segment: SessionStatuslineSegment): void;
  clearStatuslineSegment(session: string, id: string, line?: "top" | "bottom"): void;
  setServices(session: string, services: SessionServiceMetadata[]): void;
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
  sessions: {
    list(): Array<{ id: string }>;
  };
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

interface BundledPluginManifest {
  installed?: Record<string, { installedAt: string }>;
}

interface BundledPluginSpec {
  name: string;
  moduleHref: string;
  exportName?: string;
}

const DEFAULT_BUNDLED_PLUGINS: BundledPluginSpec[] = [
  {
    name: "gh-pr-context",
    moduleHref: pathToFileURL(fileURLToPath(new URL("./default-plugins/gh-pr-context.js", import.meta.url))).href,
    exportName: "createGithubPrContextPlugin",
  },
  {
    name: "transcript-length",
    moduleHref: pathToFileURL(fileURLToPath(new URL("./default-plugins/transcript-length.js", import.meta.url))).href,
  },
];

function bundledPluginWrapperPath(name: string, baseDir = getGlobalAimuxDir()): string {
  return join(baseDir, "plugins", `${name}.js`);
}

function bundledPluginManifestPath(baseDir = getGlobalAimuxDir()): string {
  return join(baseDir, "plugins", ".bundled-default-plugins.json");
}

function loadBundledPluginManifest(baseDir = getGlobalAimuxDir()): BundledPluginManifest {
  try {
    return JSON.parse(readFileSync(bundledPluginManifestPath(baseDir), "utf-8")) as BundledPluginManifest;
  } catch {
    return {};
  }
}

function saveBundledPluginManifest(manifest: BundledPluginManifest, baseDir = getGlobalAimuxDir()): void {
  mkdirSync(join(baseDir, "plugins"), { recursive: true });
  writeFileSync(bundledPluginManifestPath(baseDir), JSON.stringify(manifest, null, 2) + "\n");
}

export function ensureBundledDefaultPluginWrappers(baseDir = getGlobalAimuxDir()): void {
  const pluginsDir = join(baseDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });

  const manifest = loadBundledPluginManifest(baseDir);
  const installed = manifest.installed ?? {};
  for (const plugin of DEFAULT_BUNDLED_PLUGINS) {
    if (installed[plugin.name]) {
      continue;
    }
    const wrapperPath = bundledPluginWrapperPath(plugin.name, baseDir);
    if (!existsSync(wrapperPath)) {
      const wrapperSource = plugin.exportName
        ? `import { ${plugin.exportName} } from ${JSON.stringify(plugin.moduleHref)};\n` +
          `export default ${plugin.exportName};\n`
        : `import pluginFactory from ${JSON.stringify(plugin.moduleHref)};\n` + `export default pluginFactory;\n`;
      writeFileSync(wrapperPath, wrapperSource);
    }
    installed[plugin.name] = { installedAt: new Date().toISOString() };
  }
  manifest.installed = installed;
  saveBundledPluginManifest(manifest, baseDir);
}

export class PluginRuntime {
  private instances: AimuxPluginInstance[] = [];
  private readonly statuslineSegments = new Set<string>();

  constructor(
    private readonly endpoint: MetadataApiEndpoint,
    private readonly eventBus?: ProjectEventBus,
    private readonly onMetadataChange?: () => void,
  ) {}

  private applyMetadataChange(mutator: () => void): void {
    mutator();
    this.onMetadataChange?.();
  }

  private segmentKey(session: string, line: "top" | "bottom", id: string): string {
    return `${session}\0${line}\0${id}`;
  }

  private clearStatuslineSegment(session: string, id: string, line?: "top" | "bottom"): void {
    this.applyMetadataChange(() => {
      updateSessionMetadata(session, (existing) => {
        const next = { ...existing };
        if (!next.statusline) return next;
        const lines = line ? [line] : (["top", "bottom"] as const);
        next.statusline = { ...next.statusline };
        for (const currentLine of lines) {
          const filtered = (next.statusline[currentLine] ?? []).filter((entry) => entry.id !== id);
          if (filtered.length > 0) {
            next.statusline[currentLine] = filtered;
          } else {
            delete next.statusline[currentLine];
          }
          this.statuslineSegments.delete(this.segmentKey(session, currentLine, id));
        }
        if (!next.statusline.top?.length && !next.statusline.bottom?.length) {
          delete next.statusline;
        }
        return next;
      });
    });
  }

  private clearOwnedStatuslineSegments(): void {
    const owned = [...this.statuslineSegments];
    this.statuslineSegments.clear();
    for (const key of owned) {
      const [session, line, id] = key.split("\0") as [string, "top" | "bottom", string];
      this.clearStatuslineSegment(session, id, line);
    }
  }

  private publishEventAlert(sessionId: string, event: AgentEvent): void {
    if (!this.eventBus) return;
    const alert = deriveAlertFromAgentEvent(sessionId, event);
    if (!alert) return;
    this.eventBus.publishAlert(alert);
  }

  async start(): Promise<void> {
    const tracker = new AgentTracker();
    const api: AimuxPluginAPI = {
      projectRoot: getRepoRoot(),
      projectId: getProjectId(),
      serverHost: this.endpoint.host,
      serverPort: this.endpoint.port,
      metadata: {
        setStatus: (session, text, tone) => {
          this.applyMetadataChange(() => {
            updateSessionMetadata(session, (current) => ({
              ...current,
              status: { text, tone },
            }));
          });
        },
        setProgress: (session, current, total, label) => {
          this.applyMetadataChange(() => {
            updateSessionMetadata(session, (existing) => ({
              ...existing,
              progress: { current, total, label },
            }));
          });
        },
        log: (session, message, opts) => {
          this.applyMetadataChange(() => {
            updateSessionMetadata(session, (existing) => ({
              ...existing,
              logs: [
                ...(existing.logs ?? []).slice(-19),
                { message, source: opts?.source, tone: opts?.tone, ts: new Date().toISOString() },
              ],
            }));
          });
        },
        clearLog: (session) => {
          this.applyMetadataChange(() => {
            clearSessionLogs(session);
          });
        },
        setContext: (session, context) => {
          this.applyMetadataChange(() => {
            updateSessionMetadata(session, (existing) => ({
              ...existing,
              context: {
                ...(existing.context ?? {}),
                ...context,
              },
            }));
          });
        },
        setStatuslineSegment: (session, line, segment) => {
          if (segment.id) {
            this.statuslineSegments.add(this.segmentKey(session, line, segment.id));
          }
          this.applyMetadataChange(() => {
            updateSessionMetadata(session, (existing) => ({
              ...existing,
              statusline: {
                ...(existing.statusline ?? {}),
                [line]: [...(existing.statusline?.[line] ?? []).filter((entry) => entry.id !== segment.id), segment],
              },
            }));
          });
        },
        clearStatuslineSegment: (session, id, line) => {
          this.clearStatuslineSegment(session, id, line);
        },
        setServices: (session, services) => {
          this.applyMetadataChange(() => {
            updateSessionMetadata(session, (existing) => ({
              ...existing,
              derived: {
                ...(existing.derived ?? {}),
                services,
              },
            }));
          });
        },
        emitEvent: (session, event) => {
          this.applyMetadataChange(() => {
            tracker.emit(session, event);
            this.publishEventAlert(session, event);
          });
        },
        markSeen: (session) => {
          this.applyMetadataChange(() => {
            tracker.markSeen(session);
          });
        },
        setActivity: (session, activity) => {
          this.applyMetadataChange(() => {
            tracker.setActivity(session, activity);
          });
        },
        setAttention: (session, attention) => {
          this.applyMetadataChange(() => {
            tracker.setAttention(session, attention);
          });
        },
      },
      sessions: {
        list: () => Object.keys(loadMetadataState().sessions).map((id) => ({ id })),
      },
    };

    for (const watcher of createBuiltinMetadataWatchers(api)) {
      if (watcher.start) await watcher.start();
      this.instances.push(watcher);
    }

    // Keep the PR context implementation in userland: ship a default wrapper once,
    // then let users edit or delete ~/.aimux/plugins/*.js however they want.
    ensureBundledDefaultPluginWrappers();

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
    this.clearOwnedStatuslineSegments();
    this.instances = [];
  }
}

export function deriveAlertFromAgentEvent(
  sessionId: string,
  event: AgentEvent,
):
  | {
      kind: AlertKind;
      sessionId: string;
      title: string;
      message: string;
      dedupeKey: string;
      cooldownMs: number;
    }
  | undefined {
  let kind: AlertKind | null = null;
  if (event.kind === "needs_input") kind = "needs_input";
  else if (event.kind === "blocked") kind = "blocked";
  else if (event.kind === "task_done") kind = "task_done";
  else if (event.kind === "task_failed") kind = "task_failed";
  else if (event.kind === "notify" && event.tone === "error") kind = "task_failed";
  else if (event.kind === "notify") kind = "notification";

  if (!kind) return undefined;

  const sessionLabel = sessionId.trim() || "agent";
  const title =
    kind === "needs_input"
      ? `${sessionLabel} needs input`
      : kind === "blocked"
        ? `${sessionLabel} is blocked`
        : kind === "task_done"
          ? `${sessionLabel} finished`
          : kind === "notification"
            ? sessionLabel
            : `${sessionLabel} failed`;
  const message =
    event.message?.trim() ||
    (kind === "needs_input"
      ? "Agent is ready for your input."
      : kind === "blocked"
        ? "Agent is blocked."
        : kind === "task_done"
          ? "Agent completed its work."
          : kind === "notification"
            ? "Agent sent a notification."
            : "Agent hit an error.");

  return {
    kind,
    sessionId,
    title,
    message,
    dedupeKey: `${kind}:${sessionId}`,
    cooldownMs: kind === "task_done" ? 10_000 : 15_000,
  };
}
