import { resolve as pathResolve } from "node:path";
import { initProject } from "./config.js";
import { log } from "./debug.js";
import { removeMetadataEndpoint } from "./metadata-store.js";
import { Multiplexer } from "./multiplexer/index.js";
import { ensureProjectPaths, getProjectIdFor, withProjectPaths } from "./paths.js";

export interface CoreProjectActorState {
  projectId: string;
  projectRoot: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
}

export class CoreProjectActor {
  private mux: Multiplexer | null = null;
  private started = false;
  private readonly state: CoreProjectActorState;

  constructor(projectRoot: string) {
    const resolvedRoot = pathResolve(projectRoot);
    const now = new Date().toISOString();
    this.state = {
      projectId: getProjectIdFor(resolvedRoot),
      projectRoot: resolvedRoot,
      pid: process.pid,
      startedAt: now,
      updatedAt: now,
    };
  }

  getState(): CoreProjectActorState {
    return { ...this.state, updatedAt: new Date().toISOString() };
  }

  isRunning(): boolean {
    return this.started;
  }

  async start(): Promise<CoreProjectActorState> {
    if (this.started) return this.getState();
    await withProjectPaths(this.state.projectRoot, async () => {
      ensureProjectPaths();
      initProject();
      const mux = new Multiplexer({
        contextWatcherEnabled: false,
        projectRoot: this.state.projectRoot,
      });
      this.mux = mux;
      try {
        await mux.startProjectServiceHost();
      } catch (error) {
        this.mux = null;
        this.started = false;
        await mux.cleanup().catch((cleanupError: unknown) => {
          log.warn("failed to clean up core project actor after startup failure", "daemon", {
            projectId: this.state.projectId,
            projectRoot: this.state.projectRoot,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        });
        removeMetadataEndpoint(this.state.projectRoot);
        throw error;
      }
      this.started = true;
    });
    log.info("started core project actor", "daemon", {
      projectId: this.state.projectId,
      projectRoot: this.state.projectRoot,
      pid: process.pid,
    });
    return this.getState();
  }

  async stop(): Promise<void> {
    if (!this.mux && !this.started) return;
    const mux = this.mux;
    this.mux = null;
    this.started = false;
    await withProjectPaths(this.state.projectRoot, async () => {
      await mux?.cleanup();
      removeMetadataEndpoint(this.state.projectRoot);
    });
    log.info("stopped core project actor", "daemon", {
      projectId: this.state.projectId,
      projectRoot: this.state.projectRoot,
      pid: process.pid,
    });
  }
}
