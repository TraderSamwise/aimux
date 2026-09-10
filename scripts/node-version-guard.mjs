import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function repoRootFromScriptUrl(scriptUrl) {
  return resolve(dirname(fileURLToPath(scriptUrl)), "..");
}

export function readPinnedNodeVersion(repoRoot) {
  const pinned = readFileSync(join(repoRoot, ".nvmrc"), "utf8").trim();
  if (!pinned) {
    throw new Error(".nvmrc is empty");
  }
  return pinned.replace(/^v/, "");
}

export function normalizeNodeVersion(version) {
  return version.trim().replace(/^v/, "");
}

export function nodeVersionGuardAction({ currentVersion, pinnedVersion, nvmDir, ci = false, alreadyRetried = false }) {
  const current = normalizeNodeVersion(currentVersion);
  const pinned = normalizeNodeVersion(pinnedVersion);
  if (current === pinned) {
    return { kind: "ok" };
  }
  const message = `Aimux JS tests require Node ${pinned} from .nvmrc, but this shell is running Node ${current}.`;
  if (ci) {
    return { kind: "error", message: `${message} Configure CI to use .nvmrc.` };
  }
  if (alreadyRetried) {
    return { kind: "error", message: `${message} Tried nvm once and still got the wrong version.` };
  }
  const resolvedNvmDir = nvmDir || join(process.env.HOME || "", ".nvm");
  const nvmScript = join(resolvedNvmDir, "nvm.sh");
  if (!existsSync(nvmScript)) {
    return {
      kind: "error",
      message: `${message} nvm was not found at ${nvmScript}; run: nvm install ${pinned} && nvm use ${pinned}`,
    };
  }
  return { kind: "reexec", pinnedVersion: pinned, nvmScript };
}
