import { readFileSync } from "node:fs";
import { dirname as pathDirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";

function readPackageVersion(): string {
  try {
    const pkgPath = pathJoin(pathDirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** aimux package version, read once at module load from the bundled package.json. */
export const AIMUX_VERSION = readPackageVersion();
