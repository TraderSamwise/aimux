import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getProjectStateDirFor } from "../paths.js";
import type { AimuxPluginAPI, AimuxPluginInstance } from "../plugin-runtime.js";
import type { SessionContextMetadata } from "../metadata-store.js";

const POLL_INTERVAL_MS = 15_000;
const PR_CACHE_TTL_MS = 30_000;
const FILE_CACHE_TTL_MS = 2_000;

interface SessionTarget {
  id: string;
  worktreePath?: string;
}

interface PrCacheEntry {
  value: SessionContextMetadata["pr"] | null;
  expiresAt: number;
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
    execFile(command, args, { encoding: "utf-8", ...options }, (error, stdout) => {
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

export function createGithubPrContextPlugin(api: AimuxPluginAPI): AimuxPluginInstance {
  const projectStateDir = getProjectStateDirFor(api.projectRoot);
  const statuslinePath = join(projectStateDir, "statusline.json");
  const statePath = join(projectStateDir, "state.json");
  const metadataPath = join(projectStateDir, "metadata.json");

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

  function collectTargets(): SessionTarget[] {
    const targets = new Map<string, SessionTarget>();
    const statusline = loadCachedJson(statuslinePath);
    const state = loadCachedJson(statePath);
    const metadata = loadCachedJson(metadataPath);

    for (const session of statusline?.sessions ?? []) {
      const existingContext = metadata?.sessions?.[session.id]?.context ?? {};
      targets.set(session.id, {
        id: session.id,
        worktreePath: session.worktreePath ?? existingContext.worktreePath ?? existingContext.cwd,
      });
    }

    for (const session of state?.sessions ?? []) {
      if (!targets.has(session.id)) {
        targets.set(session.id, {
          id: session.id,
          worktreePath: session.worktreePath,
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

    for (const [sessionId, sessionMetadata] of Object.entries(metadata?.sessions ?? {})) {
      if (!targets.has(sessionId)) {
        targets.set(sessionId, {
          id: sessionId,
          worktreePath: (sessionMetadata as any)?.context?.worktreePath ?? (sessionMetadata as any)?.context?.cwd,
        });
      }
    }

    return [...targets.values()].filter((target) => Boolean(target.worktreePath));
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
    const value = await resolveBranchPr(cwd, repo, branch);
    prCache.set(cacheKey, { value, expiresAt: now + PR_CACHE_TTL_MS });
    return value;
  }

  async function refreshOne(target: SessionTarget): Promise<void> {
    if (!target.worktreePath) return;
    const gitContext = await resolveGitContext(target.worktreePath);
    if (!gitContext) return;

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
      for (const target of collectTargets()) {
        await refreshOne(target);
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
