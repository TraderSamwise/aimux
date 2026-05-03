import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getProjectStateDirFor } from "../paths.js";
import { writeJsonAtomic } from "../atomic-write.js";
import type { AimuxPluginAPI, AimuxPluginInstance } from "../plugin-runtime.js";
import type { SessionContextMetadata } from "../metadata-store.js";

const POLL_INTERVAL_MS = 60_000;
const PR_CACHE_TTL_MS = 5 * 60_000;
const PR_CACHE_PENDING_TTL_MS = 20_000;
const COMMAND_TIMEOUT_MS = 5_000;
const FILE_CACHE_TTL_MS = 5_000;

interface SessionTarget {
  id: string;
  worktreePath?: string;
}

interface PrCacheEntry {
  value: SessionContextMetadata["pr"] | null;
  expiresAt: number;
  pendingUntil?: number;
}

interface FileCacheEntry {
  value: any;
  expiresAt: number;
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function execFileText(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolvePromise) => {
    execFile(command, args, { encoding: "utf-8", timeout: COMMAND_TIMEOUT_MS, ...options }, (error, stdout) => {
      if (error) {
        resolvePromise({ ok: false, stdout: "" });
        return;
      }
      resolvePromise({ ok: true, stdout: stdout ?? "" });
    });
  });
}

function parseGithubRemote(remote: string | undefined): SessionContextMetadata["repo"] | null {
  if (!remote) return null;
  const match = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!match) return { remote };
  return {
    owner: match[1],
    name: match[2].replace(/\.git$/, ""),
    remote,
  };
}

async function resolveGitContext(worktreePath: string): Promise<SessionContextMetadata | null> {
  const cwd = resolve(worktreePath);
  const [repoRootResult, branchResult, remoteResult] = await Promise.all([
    execFileText("git", ["rev-parse", "--show-toplevel"], { cwd }),
    execFileText("git", ["branch", "--show-current"], { cwd }),
    execFileText("git", ["remote", "get-url", "origin"], { cwd }),
  ]);
  if (!repoRootResult.ok) return null;

  const repoRoot = repoRootResult.stdout.trim();
  const branch = branchResult.ok ? branchResult.stdout.trim() || undefined : undefined;
  const remote = remoteResult.ok ? remoteResult.stdout.trim() || undefined : undefined;
  const repo = parseGithubRemote(remote);

  return {
    cwd,
    worktreePath: cwd,
    worktreeName: basename(cwd),
    branch,
    repo: repo ?? undefined,
    pr: undefined,
    // repoRoot is only used for cache key and not stored in metadata.
    ...(repoRoot ? { __repoRoot: repoRoot } : {}),
  } as SessionContextMetadata & { __repoRoot: string };
}

async function resolveBranchPr(
  cwd: string,
  repo: SessionContextMetadata["repo"] | undefined,
  branch: string | undefined,
): Promise<SessionContextMetadata["pr"] | null> {
  if (!repo?.owner || !repo?.name || !branch) return null;
  const result = await execFileText(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      `${repo.owner}/${repo.name}`,
      "--state",
      "open",
      "--head",
      branch,
      "--json",
      "number,title,url,headRefName,baseRefName",
      "--limit",
      "1",
    ],
    { cwd },
  );
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    const first = Array.isArray(parsed) ? parsed[0] : null;
    if (!first) return null;
    return {
      number: first.number,
      title: first.title,
      url: first.url,
      headRef: first.headRefName,
      baseRef: first.baseRefName,
    };
  } catch {
    return null;
  }
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function collectGithubPrTargets(statusline: any, state: any, metadata: any): SessionTarget[] {
  const targets = new Map<string, SessionTarget>();

  for (const session of statusline?.sessions ?? []) {
    const existingContext = metadata?.sessions?.[session.id]?.context ?? {};
    targets.set(session.id, {
      id: session.id,
      worktreePath: session.worktreePath ?? existingContext.worktreePath ?? existingContext.cwd,
    });
  }

  for (const session of state?.sessions ?? []) {
    if (!targets.has(session.id)) {
      const existingContext = metadata?.sessions?.[session.id]?.context ?? {};
      targets.set(session.id, {
        id: session.id,
        worktreePath: session.worktreePath ?? existingContext.worktreePath ?? existingContext.cwd,
      });
    }
  }

  for (const service of state?.services ?? []) {
    if (!targets.has(service.id)) {
      targets.set(service.id, {
        id: service.id,
        worktreePath: service.worktreePath,
      });
    }
  }

  return [...targets.values()].filter((target) => Boolean(target.worktreePath));
}

export function createGithubPrContextPlugin(api: AimuxPluginAPI): AimuxPluginInstance {
  const projectStateDir = getProjectStateDirFor(api.projectRoot);
  const statuslinePath = join(projectStateDir, "statusline.json");
  const statePath = join(projectStateDir, "state.json");
  const metadataPath = join(projectStateDir, "metadata.json");
  const prCachePath = join(projectStateDir, "plugin-cache", "gh-pr-context.json");

  const prCache = new Map<string, PrCacheEntry>();
  const contextCache = new Map<string, string>();
  const fileCache = new Map<string, FileCacheEntry>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  function loadCachedJson(path: string): any | null {
    const now = Date.now();
    const cached = fileCache.get(path);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const value = readJson(path);
    fileCache.set(path, { value, expiresAt: now + FILE_CACHE_TTL_MS });
    return value;
  }

  function loadDiskPrCache(): Record<string, PrCacheEntry> {
    const raw = readJson(prCachePath);
    return raw && typeof raw === "object" ? ((raw as any).entries ?? {}) : {};
  }

  function saveDiskPrCache(entries: Record<string, PrCacheEntry>): void {
    mkdirSync(join(projectStateDir, "plugin-cache"), { recursive: true });
    writeJsonAtomic(prCachePath, {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries,
    });
  }

  function collectTargets(): SessionTarget[] {
    const statusline = loadCachedJson(statuslinePath);
    const state = loadCachedJson(statePath);
    const metadata = loadCachedJson(metadataPath);
    return collectGithubPrTargets(statusline, state, metadata);
  }

  async function resolveCachedPr(
    repoRoot: string,
    cwd: string,
    repo: SessionContextMetadata["repo"] | undefined,
    branch: string | undefined,
  ): Promise<SessionContextMetadata["pr"] | null> {
    const cacheKey = `${repoRoot}::${branch ?? ""}`;
    const now = Date.now();
    const cached = prCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const diskEntries = loadDiskPrCache();
    const diskCached = diskEntries[cacheKey];
    if (diskCached && diskCached.expiresAt > now) {
      prCache.set(cacheKey, diskCached);
      return diskCached.value;
    }
    if (diskCached?.pendingUntil && diskCached.pendingUntil > now) {
      return diskCached.value ?? null;
    }
    diskEntries[cacheKey] = {
      value: diskCached?.value ?? null,
      expiresAt: diskCached?.expiresAt ?? 0,
      pendingUntil: now + PR_CACHE_PENDING_TTL_MS,
    };
    saveDiskPrCache(diskEntries);
    const value = await resolveBranchPr(cwd, repo, branch);
    const next = { value, expiresAt: Date.now() + PR_CACHE_TTL_MS };
    prCache.set(cacheKey, next);
    saveDiskPrCache({
      ...loadDiskPrCache(),
      [cacheKey]: next,
    });
    return value;
  }

  async function refreshOneWithContext(
    target: SessionTarget,
    gitContext: SessionContextMetadata & { __repoRoot?: string },
  ): Promise<void> {
    const repoRoot = (gitContext as any).__repoRoot as string;
    delete (gitContext as any).__repoRoot;
    gitContext.pr = (await resolveCachedPr(repoRoot, gitContext.cwd!, gitContext.repo, gitContext.branch)) ?? undefined;

    const serialized = stableSerialize(gitContext);
    if (contextCache.get(target.id) === serialized) return;
    contextCache.set(target.id, serialized);
    api.metadata.setContext(target.id, gitContext);
  }

  async function refreshAll(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const targets = collectTargets();
      const worktreeContexts = new Map<string, SessionContextMetadata | null>();
      for (const target of targets) {
        const worktreePath = target.worktreePath;
        if (!worktreePath || worktreeContexts.has(worktreePath)) continue;
        worktreeContexts.set(worktreePath, await resolveGitContext(worktreePath));
      }
      for (const target of targets) {
        if (!target.worktreePath) continue;
        const gitContext = worktreeContexts.get(target.worktreePath);
        if (!gitContext) continue;
        await refreshOneWithContext(target, { ...gitContext });
      }
    } finally {
      running = false;
    }
  }

  return {
    async start() {
      await refreshAll();
      timer = setInterval(() => {
        void refreshAll();
      }, POLL_INTERVAL_MS);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
