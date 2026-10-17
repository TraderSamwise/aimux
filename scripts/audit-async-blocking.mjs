#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const roots = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const scanRoots = roots.length > 0 ? roots.map((root) => resolve(repoRoot, root)) : [resolve(repoRoot, "native/crates/aimux")];

const HAZARDS = [
  {
    id: "std-process",
    message: "std::process used inside async fn; use tokio::process or spawn_blocking",
    matches: (fnSource, fileText) =>
      /\bstd\s*::\s*process\b/.test(fnSource) ||
      /\bprocess\s*::\s*Command\b/.test(fnSource) ||
      (/\buse\s+std\s*::\s*process\s*::\s*Command\b/.test(fileText) && /\bCommand\s*::\s*new\s*\(/.test(fnSource)),
  },
  {
    id: "std-net",
    message: "std::net used inside async fn; use tokio::net or spawn_blocking",
    matches: (fnSource, fileText) =>
      /\bstd\s*::\s*net\b/.test(fnSource) ||
      (/\buse\s+std\s*::\s*net\s*::/.test(fileText) &&
        /\b(TcpListener|TcpStream|UdpSocket|UnixListener|UnixStream)\s*::/.test(fnSource)),
  },
  {
    id: "thread-sleep",
    message: "std::thread::sleep used inside async fn; use tokio::time::sleep",
    matches: (fnSource, fileText) =>
      /\bstd\s*::\s*thread\s*::\s*sleep\s*\(/.test(fnSource) ||
      (/\buse\s+std\s*::\s*thread\b/.test(fileText) && /\bthread\s*::\s*sleep\s*\(/.test(fnSource)) ||
      (/\buse\s+std\s*::\s*thread\s*::\s*sleep\b/.test(fileText) && /\bsleep\s*\(/.test(fnSource)),
  },
  {
    id: "blocking-recv",
    message: "blocking channel recv used inside async fn; use async channels or spawn_blocking",
    matches: (fnSource, fileText) =>
      /\bstd\s*::\s*sync\s*::\s*mpsc\b/.test(fnSource) ||
      /\bcrossbeam_channel\b/.test(fnSource) ||
      ((/\buse\s+std\s*::\s*sync\s*::\s*mpsc\b/.test(fileText) ||
        /\buse\s+crossbeam_channel\b/.test(fileText)) &&
        /\.(?:recv|recv_timeout)\s*\(/.test(fnSource)),
  },
];

function rustFiles(root) {
  if (!existsSync(root)) return [];
  const stat = statSync(root);
  if (stat.isFile()) return root.endsWith(".rs") ? [root] : [];
  const files = [];
  for (const entry of readdirSync(root)) {
    if (entry === "target" || entry === ".git") continue;
    files.push(...rustFiles(join(root, entry)));
  }
  return files;
}

function maskRust(text) {
  let out = "";
  let i = 0;
  let state = "code";
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1] ?? "";
    if (state === "code") {
      if (ch === "/" && next === "/") {
        out += "  ";
        i += 2;
        state = "line";
      } else if (ch === "/" && next === "*") {
        out += "  ";
        i += 2;
        state = "block";
      } else if (ch === "\"") {
        out += " ";
        i += 1;
        state = "string";
      } else if (ch === "'") {
        out += " ";
        i += 1;
        state = "char";
      } else {
        out += ch;
        i += 1;
      }
    } else if (state === "line") {
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      if (ch === "\n") state = "code";
    } else if (state === "block") {
      out += ch === "\n" ? "\n" : " ";
      if (ch === "*" && next === "/") {
        out += " ";
        i += 2;
        state = "code";
      } else {
        i += 1;
      }
    } else if (state === "string") {
      out += ch === "\n" ? "\n" : " ";
      if (ch === "\\") {
        out += next === "\n" ? "\n" : " ";
        i += 2;
      } else {
        i += 1;
        if (ch === "\"") state = "code";
      }
    } else {
      out += ch === "\n" ? "\n" : " ";
      if (ch === "\\") {
        out += next === "\n" ? "\n" : " ";
        i += 2;
      } else {
        i += 1;
        if (ch === "'") state = "code";
      }
    }
  }
  return out;
}

function lineFor(text, index) {
  return text.slice(0, index).split("\n").length;
}

function findBodyEnd(masked, openBrace) {
  let depth = 0;
  for (let i = openBrace; i < masked.length; i += 1) {
    if (masked[i] === "{") depth += 1;
    if (masked[i] === "}") depth -= 1;
    if (depth === 0) return i + 1;
  }
  return masked.length;
}

function asyncFunctions(text) {
  const masked = maskRust(text);
  const matches = [];
  const regex = /\basync\s+(?:unsafe\s+)?(?:extern\s+(?:[A-Za-z_][A-Za-z0-9_]*|"[^"]*")\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of masked.matchAll(regex)) {
    const openBrace = masked.indexOf("{", match.index + match[0].length);
    if (openBrace === -1) continue;
    const end = findBodyEnd(masked, openBrace);
    matches.push({
      name: match[1],
      start: match.index,
      openBrace,
      source: masked.slice(match.index, end),
    });
  }
  return matches;
}

const violations = [];
for (const file of scanRoots.flatMap(rustFiles)) {
  const text = readFileSync(file, "utf8");
  for (const fn of asyncFunctions(text)) {
    for (const hazard of HAZARDS) {
      if (!hazard.matches(fn.source, maskRust(text))) continue;
      violations.push({
        file: relative(repoRoot, file),
        line: lineFor(text, fn.start),
        function: fn.name,
        hazard: hazard.id,
        message: hazard.message,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("async blocking audit failed:");
  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line} ${violation.function} ${violation.hazard}: ${violation.message}`,
    );
  }
  process.exit(1);
}

console.log(`async blocking audit passed: scanned ${scanRoots.map((root) => relative(repoRoot, root)).join(", ")}`);
