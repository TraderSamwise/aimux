#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = /\.(?:sh|py|mjs)$/;
// The contract registry names source proof files rather than runtime commands.
const PROOF_REGISTRY = "native/crates/aimux/src/contracts.rs";

function filesBelow(root, relative, excludedDirs = []) {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      return excludedDirs.includes(entry.name) ? [] : filesBelow(root, path, excludedDirs);
    }
    return entry.isFile() ? [path] : [];
  });
}

function rustTokens(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const tail = source.slice(index);
    if (/^\s/.test(tail)) {
      index += 1;
    } else if (tail.startsWith("//")) {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end;
    } else if (tail.startsWith("/*")) {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else index += 1;
      }
      if (depth) throw new Error("unterminated Rust block comment");
    } else {
      const raw = /^(?:br|cr|r)(#*)"/.exec(tail);
      const quoted = /^(?:b|c)?"/.exec(tail);
      if (raw) {
        const start = index + raw[0].length;
        const delimiter = `"${raw[1]}`;
        const end = source.indexOf(delimiter, start);
        if (end < 0) throw new Error("unterminated Rust raw string");
        tokens.push({ value: source.slice(start, end), string: true });
        index = end + delimiter.length;
      } else if (quoted) {
        index += quoted[0].length;
        let value = "";
        while (index < source.length && source[index] !== '"') {
          if (source[index] === "\\") {
            value += source[index + 1] ?? "";
            index += 2;
          } else value += source[index++];
        }
        if (index >= source.length) throw new Error("unterminated Rust string");
        index += 1;
        tokens.push({ value, string: true });
      } else {
        const character = /^'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|.)|[^'\\\n])'/u.exec(tail);
        const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(tail);
        const value = character?.[0] ?? word?.[0] ?? source[index];
        tokens.push({ value });
        index += value.length;
      }
    }
  }
  return tokens;
}

function groupEnd(tokens, start) {
  const closing = { "[": "]", "(": ")", "{": "}" }[tokens[start]?.value];
  if (!closing) throw new Error("expected Rust token group");
  for (let index = start + 1; index < tokens.length; index += 1) {
    if (tokens[index].string) continue;
    if (tokens[index].value === closing) return index + 1;
    if (["[", "(", "{"].includes(tokens[index].value)) index = groupEnd(tokens, index) - 1;
  }
  throw new Error("unterminated Rust token group");
}

function cfgWithoutTests(tokens) {
  let index = 0;
  function expression() {
    const name = tokens[index++]?.value;
    if (tokens[index]?.value !== "(") {
      if (tokens[index]?.value === "=") {
        index += 2;
        return undefined;
      }
      return name === "test" ? false : undefined;
    }
    index += 1;
    const values = [];
    while (index < tokens.length && tokens[index].value !== ")") {
      values.push(expression());
      if (tokens[index]?.value === ",") index += 1;
    }
    index += 1;
    if (name === "not") return values[0] === undefined ? undefined : !values[0];
    if (name === "all")
      return values.includes(false) ? false : values.every((value) => value === true) ? true : undefined;
    if (name === "any")
      return values.includes(true) ? true : values.every((value) => value === false) ? false : undefined;
    return undefined;
  }
  return expression();
}

function productionTokens(tokens) {
  const production = [];
  for (let index = 0; index < tokens.length; ) {
    if (tokens[index].value !== "#" || tokens[index + 1]?.value !== "[") {
      production.push(tokens[index++]);
      continue;
    }
    const start = index;
    let testOnly = false;
    while (tokens[index]?.value === "#" && tokens[index + 1]?.value === "[") {
      const end = groupEnd(tokens, index + 1);
      if (tokens[index + 2]?.value === "cfg" && tokens[index + 3]?.value === "(") {
        testOnly ||= cfgWithoutTests(tokens.slice(index + 4, end - 2)) === false;
      }
      index = end;
    }
    if (!testOnly) {
      production.push(...tokens.slice(start, index));
      continue;
    }
    while (index < tokens.length) {
      const value = tokens[index].value;
      if (!tokens[index].string && value === ";") {
        index += 1;
        break;
      }
      if (!tokens[index].string && ["[", "(", "{"].includes(value)) {
        index = groupEnd(tokens, index);
        if (value === "{") break;
      } else index += 1;
    }
  }
  return production;
}

function resourcePath(path) {
  const relative = posix.normalize(path.replace(/^\.\//, ""));
  if (relative.startsWith("../") || posix.isAbsolute(relative))
    throw new Error(`runtime resource escapes package root: ${path}`);
  return relative;
}

function manifest(root) {
  const data = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!Array.isArray(data.files) || data.files.some((path) => typeof path !== "string")) {
    throw new Error("package.json files must be an array of paths");
  }
  return data.files.map(resourcePath);
}

function maintainedScripts(root, entries) {
  const paths = new Set();
  for (const entry of entries) {
    if (!entry.startsWith("scripts/") && entry !== "scripts") continue;
    if (SCRIPT.test(entry)) paths.add(entry);
    else if (existsSync(join(root, entry)) && statSync(join(root, entry)).isDirectory()) {
      for (const path of filesBelow(root, entry).filter((path) => SCRIPT.test(path))) paths.add(path);
    }
  }
  return paths;
}

function shellDependencies(path, source) {
  const dependencies = new Set();
  let text = "";
  let quote;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && quote !== "'") {
      text += source.slice(index, index + 2);
      index += 1;
    } else if (!quote && character === "#" && (index === 0 || /\s/.test(source[index - 1]))) {
      while (index < source.length && source[index] !== "\n") index += 1;
      text += "\n";
    } else {
      if (character === quote) quote = undefined;
      else if (!quote && (character === '"' || character === "'")) quote = character;
      text += character;
    }
  }
  for (const match of text.matchAll(/\bscripts\/[A-Za-z0-9_./-]+\.(?:sh|py|mjs)\b/g))
    dependencies.add(resourcePath(match[0]));
  for (const match of text.matchAll(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))\/([A-Za-z0-9_./-]+\.(?:sh|py|mjs))\b/g,
  )) {
    const variable = match[1] ?? match[2];
    if (/^(?:script_dir|scripts_dir)$/i.test(variable))
      dependencies.add(resourcePath(posix.join(posix.dirname(path), match[3])));
    else if (/^(?:root_dir|repo|repo_root|aimux_root|root)$/i.test(variable)) dependencies.add(resourcePath(match[3]));
  }
  for (const match of text.matchAll(
    /(?:\b(?:source|bash|sh|python3|node)\s+|\.\s+)["']?(\.?\.?\/[A-Za-z0-9_./-]+\.(?:sh|py|mjs)|[A-Za-z0-9_.-]+\.(?:sh|py|mjs))\b/g,
  )) {
    dependencies.add(resourcePath(posix.join(posix.dirname(path), match[1])));
  }
  return dependencies;
}

export function discoverRuntimeScripts(root) {
  const paths = maintainedScripts(root, manifest(root));
  for (const path of filesBelow(root, "native", ["target", "tests", "node_modules"]).filter(
    (path) => path.endsWith(".rs") && path.split("/").includes("src"),
  )) {
    const tokens = productionTokens(rustTokens(readFileSync(join(root, path), "utf8")));
    for (const token of tokens.filter((token) => token.string)) {
      const matches = token.value.match(/\bscripts\/[A-Za-z0-9_./-]+\.(?:sh|py|mjs)\b/g) ?? [];
      if (/^[A-Za-z0-9_.-]+\.sh$/.test(token.value)) matches.push(`scripts/${token.value}`);
      for (const match of matches) {
        if (path === PROOF_REGISTRY && match === "scripts/phase8-live-residuals.py") continue;
        paths.add(resourcePath(match));
      }
    }
  }
  for (const path of paths) {
    if (!existsSync(join(root, path))) continue;
    if (path.endsWith(".sh")) {
      for (const dependency of shellDependencies(path, readFileSync(join(root, path), "utf8"))) paths.add(dependency);
    }
  }
  return paths;
}

function covered(path, entries) {
  return entries.some((entry) => path === entry || path.startsWith(`${entry.replace(/\/$/, "")}/`));
}

export function fullPlatforms(root) {
  const matrix = execFileSync("python3", [join(root, "scripts/release-asset-matrix.py")], { encoding: "utf8" });
  const full = matrix
    .trim()
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((entry) => entry[2] === "full");
  if (!full.length) throw new Error("release matrix lists no full platform assets");
  return full.map(([platform, arch]) => ({ platform, arch, binary: `native/${platform}-${arch}/aimux` }));
}

export function auditRuntimeManifest(root) {
  const entries = manifest(root);
  const errors = [];
  if (!covered("dist-ui/index.html", entries)) {
    errors.push("package.json files does not cover runtime UI: dist-ui/index.html");
  }
  for (const path of discoverRuntimeScripts(root)) {
    if (!existsSync(join(root, path)) || !statSync(join(root, path)).isFile())
      errors.push(`runtime script source is missing: ${path}`);
    if (!covered(path, entries)) errors.push(`package.json files does not cover runtime script: ${path}`);
  }
  for (const { binary } of fullPlatforms(root)) {
    if (!covered(binary, entries)) errors.push(`package.json files does not cover full release binary: ${binary}`);
  }
  return errors;
}

export function verifyRuntimePackagePaths(root, paths) {
  const packaged = new Set([...paths].map(resourcePath));
  return ["bin/aimux", "package.json", "dist-ui/index.html", ...discoverRuntimeScripts(root)]
    .filter((path) => !packaged.has(path))
    .map((path) => `runtime package is missing: ${path}`);
}

const RELEASE_ARCHIVE_INDEX = String.raw`
import gzip, hashlib, json, posixpath, sys, tarfile
from pathlib import PurePosixPath
records = []
seen = set()
with gzip.open(sys.argv[1], 'rb') as compressed:
    while compressed.read(1024 * 1024):
        pass
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for member in archive:
        path = PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'aimux' or chr(92) in member.name:
            sys.exit('unsafe release archive path: ' + member.name)
        name = str(path.relative_to('aimux'))
        if name in seen:
            sys.exit('duplicate release archive member: ' + name)
        seen.add(name)
        if not 0 <= member.mode <= 0o7777 or member.size < 0:
            sys.exit('invalid release archive mode or size: ' + name)
        if member.isdir():
            continue
        record = {'path': name, 'mode': member.mode, 'regular': member.isfile()}
        if member.issym():
            target = posixpath.normpath(posixpath.join(posixpath.dirname(str(path)), member.linkname))
            if not member.linkname or member.linkname.startswith('/') or not target.startswith('aimux/'):
                sys.exit('unsafe release archive symlink: ' + name)
        elif not member.isfile():
            sys.exit('unsupported release archive entry: ' + name)
        if member.isfile():
            digest = hashlib.sha256()
            with archive.extractfile(member) as source:
                if name == 'PACKAGE_PROFILE':
                    if member.size > 64:
                        sys.exit('invalid release PACKAGE_PROFILE size')
                    record['profile'] = source.read().decode('ascii').strip()
                else:
                    while chunk := source.read(1024 * 1024):
                        digest.update(chunk)
            record['sha256'] = digest.hexdigest()
        records.append(record)
print(json.dumps(records))
`;

export function verifyReleaseArchive(root, archive) {
  let records;
  try {
    records = JSON.parse(
      execFileSync("python3", ["-c", RELEASE_ARCHIVE_INDEX, resolve(archive)], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (error) {
    throw new Error(`cannot inspect release archive ${archive}: ${error.stderr?.toString().trim() || error.message}`);
  }
  const index = new Map(records.map((record) => [record.path, record]));
  const profile = index.get("PACKAGE_PROFILE");
  if (!profile?.regular || !["full", "minimal"].includes(profile.profile))
    throw new Error(`release archive ${archive} requires regular PACKAGE_PROFILE containing full or minimal`);
  const required = new Set(["bin/aimux", "package.json", ...discoverRuntimeScripts(root)]);
  if (profile.profile === "full") {
    required.add("dist-ui/index.html");
    for (const path of filesBelow(root, "dist-ui")) if (!path.endsWith(".map")) required.add(path);
  }
  const errors = [];
  for (const path of required) {
    const record = index.get(path);
    if (!record?.regular) {
      errors.push(`release archive is missing regular runtime payload: ${path}`);
      continue;
    }
    const source = join(root, path);
    const digest = createHash("sha256").update(readFileSync(source)).digest("hex");
    if (record.sha256 !== digest) errors.push(`release archive differs from runtime source: ${path}`);
    if (statSync(source).mode & 0o100 && !(record.mode & 0o100))
      errors.push(`release archive lost executable permission: ${path}`);
  }
  if (errors.length) throw new Error(`${archive}: ${errors.join("\n")}`);
  return records.map((record) => record.path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 4 && process.argv[2] === "--release-archive") {
      verifyReleaseArchive(ROOT, process.argv[3]);
      process.stdout.write("release runtime archive audit passed\n");
    } else {
      if (process.argv.length !== 2)
        throw new Error("usage: audit-runtime-package.mjs [--release-archive PACKAGE.tar.gz]");
      const errors = auditRuntimeManifest(ROOT);
      if (errors.length) throw new Error(errors.join("\n"));
      process.stdout.write("runtime package manifest audit passed\n");
    }
  } catch (error) {
    process.stderr.write(`runtime package manifest audit failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
