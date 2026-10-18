#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditRuntimeManifest, fullPlatforms, verifyRuntimePackagePaths } from "./audit-runtime-package.mjs";

export { fullPlatforms };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TAR_INDEX = String.raw`
import gzip, hashlib, json, sys, tarfile
from pathlib import PurePosixPath
records = []
seen = set()
with gzip.open(sys.argv[1], 'rb') as compressed:
    while compressed.read(1024 * 1024):
        pass
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for member in archive:
        path = PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'package':
            sys.exit('unsafe npm archive path: ' + member.name)
        name = str(path.relative_to('package'))
        if name in seen:
            sys.exit('duplicate npm archive member: ' + name)
        seen.add(name)
        if member.isdir():
            continue
        if not member.isfile():
            sys.exit('non-regular npm archive member: ' + name)
        digest = hashlib.sha256()
        with archive.extractfile(member) as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        records.append({'path': name, 'mode': member.mode, 'sha256': digest.hexdigest()})
print(json.dumps(records))
`;

function regularFile(root, path, executable = false) {
  const stat = lstatSync(join(root, path));
  if (!stat.isFile() || (executable && !(stat.mode & 0o100))) {
    throw new Error(`staged npm runtime file must be ${executable ? "executable and " : ""}regular: ${path}`);
  }
}

export function verifyStagedNatives(root) {
  const errors = auditRuntimeManifest(root);
  if (errors.length) throw new Error(errors.join("\n"));
  for (const { platform, arch, binary } of fullPlatforms(root)) {
    try {
      regularFile(root, binary, true);
      if (platform === "linux")
        execFileSync("python3", [join(ROOT, "scripts/verify-linux-binary.py"), join(root, binary), arch], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      if (platform === "darwin") {
        const bundle = dirname(binary) + "/aimux-notifier.app";
        regularFile(root, `${bundle}/Contents/MacOS/aimux-notifier`, true);
        regularFile(root, `${bundle}/Contents/Info.plist`);
      }
    } catch (error) {
      const cause = error.stderr?.toString().trim() || error.message;
      throw new Error(
        `npm requires the complete staged full release set; ${binary}: ${cause}. Stage verified release assets with scripts/stage-npm-assets.py before packing.`,
      );
    }
  }
}

function filesIn(root, path) {
  const stat = lstatSync(join(root, path));
  if (stat.isDirectory()) return readdirSync(join(root, path)).flatMap((name) => filesIn(root, `${path}/${name}`));
  if (!stat.isFile()) throw new Error(`staged npm payload contains a non-regular file: ${path}`);
  return [path];
}

export function verifyNpmPackage(root, archive) {
  verifyStagedNatives(root);
  const records = JSON.parse(
    execFileSync("python3", ["-c", TAR_INDEX, resolve(archive)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }),
  );
  const paths = records.map((record) => record.path);
  const errors = verifyRuntimePackagePaths(root, paths);
  const index = new Map(records.map((record) => [record.path, record]));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  regularFile(root, "dist-ui/index.html");
  const expected = new Set([
    "package.json",
    ...filesIn(root, "dist-ui"),
    ...manifest.files.flatMap((path) => filesIn(root, path)),
  ]);
  for (const path of paths) {
    if (path.endsWith(".map") || path === "dist" || path.startsWith("dist/"))
      errors.push(`npm archive contains retired or debug payload: ${path}`);
  }
  for (const path of expected) {
    const record = index.get(path);
    if (!record) {
      errors.push(`npm archive is missing staged runtime payload: ${path}`);
      continue;
    }
    const digest = createHash("sha256")
      .update(readFileSync(join(root, path)))
      .digest("hex");
    if (record.sha256 !== digest) errors.push(`npm archive differs from staged runtime payload: ${path}`);
    if (lstatSync(join(root, path)).mode & 0o100 && !(record.mode & 0o100))
      errors.push(`npm archive lost executable permission: ${path}`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return paths;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: verify-npm-package.mjs --staged-natives|PACKAGE.tgz");
    if (process.argv[2] === "--staged-natives") verifyStagedNatives(ROOT);
    else verifyNpmPackage(ROOT, process.argv[2]);
    process.stdout.write("npm runtime package verification passed\n");
  } catch (error) {
    process.stderr.write(`npm runtime package verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
