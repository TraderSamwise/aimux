import { readFileSync } from "node:fs";
import { dirname as pathDirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";

export const BUILD_PROFILES = ["full", "local"] as const;
export type AimuxBuildProfile = (typeof BUILD_PROFILES)[number];

const DEFAULT_BUILD_PROFILE: AimuxBuildProfile = "full";

export function parseAimuxBuildProfile(value: string | undefined | null): AimuxBuildProfile | null {
  const trimmed = value?.trim();
  if (trimmed === "full" || trimmed === "local") return trimmed;
  return null;
}

export function readAimuxBuildProfileFromPackageRoot(packageRoot: string): AimuxBuildProfile {
  try {
    const profile = parseAimuxBuildProfile(readFileSync(pathJoin(packageRoot, "BUILD_PROFILE"), "utf8"));
    if (profile) return profile;
  } catch {
    // Source checkouts and older installs do not have a BUILD_PROFILE artifact.
  }

  return parseAimuxBuildProfile(process.env.AIMUX_BUILD_PROFILE) ?? DEFAULT_BUILD_PROFILE;
}

export const AIMUX_BUILD_PROFILE = readAimuxBuildProfileFromPackageRoot(
  pathJoin(pathDirname(fileURLToPath(import.meta.url)), ".."),
);
