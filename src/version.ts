import { readFileSync } from "node:fs";
import { dirname as pathDirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_VERSION = "0.0.0";

export function readAimuxVersionFromPackageRoot(packageRoot: string): string {
  const versionPath = pathJoin(packageRoot, "VERSION");
  try {
    const version = readFileSync(versionPath, "utf8").trim();
    if (version) return version;
  } catch {
    // Source checkouts do not have a VERSION artifact.
  }

  try {
    const pkgPath = pathJoin(packageRoot, "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? DEFAULT_VERSION;
  } catch {
    return DEFAULT_VERSION;
  }
}

/** aimux installed artifact label, read once at module load. */
export const AIMUX_VERSION = readAimuxVersionFromPackageRoot(
  pathJoin(pathDirname(fileURLToPath(import.meta.url)), ".."),
);
