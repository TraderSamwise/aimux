import { spawn } from "node:child_process";

export interface FooterPluginContext {
  projectCwd: string;
  activeSessionId?: string;
  activeSessionPath: string;
  locationLabel: string;
  branch?: string;
  worktreeName?: string;
  isMainCheckout: boolean;
}

interface FooterPluginDefinition {
  id: string;
  ttlMs?: number;
  renderSync?: (ctx: FooterPluginContext) => string | null;
  resolve?: (ctx: FooterPluginContext) => Promise<string | null>;
  getCacheKey?: (ctx: FooterPluginContext) => string;
}

interface FooterPluginCacheEntry {
  key: string;
  value: string | null;
  updatedAt: number;
  pending: boolean;
}

const DEFAULT_TTL_MS = 30_000;

export class FooterPluginManager {
  private cache = new Map<string, FooterPluginCacheEntry>();
  private plugins: FooterPluginDefinition[];
  private onUpdate: () => void;

  constructor(pluginIds: string[], onUpdate: () => void) {
    this.plugins = pluginIds.map((id) => BUILTIN_FOOTER_PLUGINS[id]).filter(Boolean);
    this.onUpdate = onUpdate;
  }

  render(ctx: FooterPluginContext): string[] {
    const parts: string[] = [];

    for (const plugin of this.plugins) {
      if (plugin.renderSync) {
        const value = plugin.renderSync(ctx);
        if (value) parts.push(value);
        continue;
      }

      if (!plugin.resolve) continue;

      const cacheKey = plugin.getCacheKey?.(ctx) ?? ctx.activeSessionPath;
      const stateKey = `${plugin.id}:${cacheKey}`;
      const cached = this.cache.get(stateKey);
      const ttlMs = plugin.ttlMs ?? DEFAULT_TTL_MS;
      const now = Date.now();

      if (!cached || now - cached.updatedAt > ttlMs) {
        this.refreshPlugin(plugin, ctx, stateKey, cacheKey);
      }

      if (cached?.value) {
        parts.push(cached.value);
      }
    }

    return parts;
  }

  private refreshPlugin(
    plugin: FooterPluginDefinition,
    ctx: FooterPluginContext,
    stateKey: string,
    cacheKey: string,
  ): void {
    const existing = this.cache.get(stateKey);
    if (existing?.pending) return;

    this.cache.set(stateKey, {
      key: cacheKey,
      value: existing?.value ?? null,
      updatedAt: existing?.updatedAt ?? 0,
      pending: true,
    });

    void plugin.resolve!(ctx)
      .then((value) => {
        this.cache.set(stateKey, {
          key: cacheKey,
          value,
          updatedAt: Date.now(),
          pending: false,
        });
        this.onUpdate();
      })
      .catch(() => {
        this.cache.set(stateKey, {
          key: cacheKey,
          value: null,
          updatedAt: Date.now(),
          pending: false,
        });
      });
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 2_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ ok, stdout: stdout.trim(), stderr: stderr.trim() });
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(false);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", () => {
      clearTimeout(timeout);
      finish(false);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      finish(code === 0);
    });
  });
}

async function resolveGithubPrLabel(ctx: FooterPluginContext): Promise<string | null> {
  const ghVersion = await runCommand("gh", ["--version"], ctx.activeSessionPath, 1_500);
  if (!ghVersion.ok) return null;

  const ghAuth = await runCommand("gh", ["auth", "status"], ctx.activeSessionPath, 1_500);
  if (!ghAuth.ok) return null;

  const branchResult = await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], ctx.activeSessionPath, 1_500);
  if (!branchResult.ok || !branchResult.stdout || branchResult.stdout === "HEAD") return null;

  let prResult = await runCommand("gh", ["pr", "view", "--json", "url", "--jq", ".url"], ctx.activeSessionPath, 2_500);

  if (!prResult.ok || !prResult.stdout) {
    prResult = await runCommand(
      "gh",
      ["pr", "list", "--head", branchResult.stdout, "--json", "url", "--jq", ".[0].url"],
      ctx.activeSessionPath,
      2_500,
    );
  }

  if (!prResult.ok || !prResult.stdout || prResult.stdout === "null") return null;
  return `PR ${prResult.stdout}`;
}

const BUILTIN_FOOTER_PLUGINS: Record<string, FooterPluginDefinition> = {
  location: {
    id: "location",
    renderSync: (ctx) => ctx.locationLabel,
  },
  "github-pr": {
    id: "github-pr",
    ttlMs: 30_000,
    getCacheKey: (ctx) => `${ctx.activeSessionPath}:${ctx.branch ?? ""}`,
    resolve: resolveGithubPrLabel,
  },
};
