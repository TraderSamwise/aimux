import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PROJECT_SERVICE_API_VERSION = 4;
export const PROJECT_SERVICE_CAPABILITIES = {
  structuredAgentInput: true,
  parsedAgentOutput: true,
  attachments: true,
  agentHistory: true,
  chatEventStream: true,
} as const;

export interface ProjectServiceManifest {
  apiVersion: number;
  capabilities: Record<string, boolean>;
  buildStamp: string;
}

function computeBuildStamp(): string {
  const candidateUrls = [new URL("./main.js", import.meta.url), new URL("./main.ts", import.meta.url)];
  const entryPath = candidateUrls.map((url) => fileURLToPath(url)).find((candidate) => existsSync(candidate));
  if (!entryPath) {
    throw new Error("unable to locate project service entrypoint for build stamp");
  }
  const stat = statSync(entryPath);
  const content = readFileSync(entryPath);
  const hash = createHash("sha1").update(content).digest("hex").slice(0, 12);
  return `${Math.trunc(stat.mtimeMs)}-${hash}`;
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
