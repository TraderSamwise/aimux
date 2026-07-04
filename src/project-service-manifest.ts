import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PROJECT_SERVICE_API_VERSION = 4;
export const PROJECT_SERVICE_CAPABILITIES = {
  parsedAgentOutput: true,
  attachmentRead: true,
  chatEventStream: true,
} as const;

export interface ProjectServiceManifest {
  apiVersion: number;
  capabilities: Record<string, boolean>;
  buildStamp: string;
}

function resolveArtifact(compiledPath: string, sourcePath: string): string {
  if (existsSync(compiledPath)) return compiledPath;
  if (existsSync(sourcePath)) return sourcePath;
  throw new Error(`unable to locate project service build artifact: ${compiledPath}`);
}

function computeBuildStamp(): string {
  const artifactPaths = [
    resolveArtifact(
      fileURLToPath(new URL("./launcher-bin.js", import.meta.url)),
      fileURLToPath(new URL("./launcher-bin.ts", import.meta.url)),
    ),
    resolveArtifact(
      fileURLToPath(new URL("./main.js", import.meta.url)),
      fileURLToPath(new URL("./main.ts", import.meta.url)),
    ),
  ];
  const hash = createHash("sha1");
  const mtimes = artifactPaths.map((entryPath) => {
    const stat = statSync(entryPath);
    hash.update(readFileSync(entryPath));
    return Math.trunc(stat.mtimeMs / 1000) * 1000;
  });
  return `${mtimes.join(".")}-${hash.digest("hex").slice(0, 12)}`;
}

export const PROJECT_SERVICE_BUILD_STAMP = computeBuildStamp();

export function getProjectServiceManifest(): ProjectServiceManifest {
  return {
    apiVersion: PROJECT_SERVICE_API_VERSION,
    capabilities: { ...PROJECT_SERVICE_CAPABILITIES },
    buildStamp: PROJECT_SERVICE_BUILD_STAMP,
  };
}

export function computeCurrentProjectServiceManifest(): ProjectServiceManifest {
  return {
    apiVersion: PROJECT_SERVICE_API_VERSION,
    capabilities: { ...PROJECT_SERVICE_CAPABILITIES },
    buildStamp: computeBuildStamp(),
  };
}

export function hasProjectServiceBuildDrift(): boolean {
  try {
    return computeCurrentProjectServiceManifest().buildStamp !== PROJECT_SERVICE_BUILD_STAMP;
  } catch {
    return false;
  }
}

export function manifestsMatch(
  expected: ProjectServiceManifest,
  actual: Partial<ProjectServiceManifest> | null | undefined,
): boolean {
  if (!actual) return false;
  if (Number(actual.apiVersion || 0) !== expected.apiVersion) return false;
  if (String(actual.buildStamp || "") !== expected.buildStamp) return false;
  const actualCapabilities = actual.capabilities || {};
  return Object.entries(expected.capabilities).every(([key, value]) => actualCapabilities[key] === value);
}
