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
    // The hazard that killed daemons: a per-connection interceptor took the
    // global runtime mutex on an async worker, and with two workers two
    // concurrent stream requests parked both. Every other connection task was
    // accepted and never polled, /health among them, and the watchdog ends the
    // process after three failed probes.
    //
    // Scoped to a SHARED mutex arriving as an `Arc<Mutex<..>>` parameter,
    // because that is the one whose hold time is someone else's to decide. A
    // function's own short-lived internal mutex is a different question.
    //
    // Measured, after two bad counts: 8 async fns in the crate take a blocking
    // `.lock()` on their own stack, 3 of them inside `mod tests` and 5 in
    // production, and none of the 5 is the daemon's global runtime mutex --
    // they are in the project service and the relay runner, locking their own
    // state. So widening this rule is triageable rather than impossible; it is
    // simply a different piece of work, and nobody has established those five
    // hold the lock long enough to matter.
    //
    // Locking inside a `spawn_blocking_named` closure is the fix, not the
    // hazard, so those bodies are removed before the check.
    id: "shared-mutex-lock",
    message:
      "shared Arc<Mutex<..>> locked on the async fn's own stack; take it inside spawn_blocking_named so waiting for it cannot park an async worker",
    matches: (fnSource) => {
      const openBrace = fnSource.indexOf("{");
      if (openBrace === -1) return false;
      const shared = [
        ...fnSource
          .slice(0, openBrace)
          .matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*&?\s*Arc\s*<\s*Mutex\s*</g),
      ].map((match) => match[1]);
      if (shared.length === 0) return false;
      const body = fnSource
        .slice(openBrace)
        .replace(/spawn_blocking_named\s*\([\s\S]*?\n\s{4,}\)/g, " ");
      return shared.some((name) =>
        new RegExp(`\\b${name}\\s*\\n?\\s*\\.\\s*lock\\s*\\(`).test(body),
      );
    },
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

/// `'a'`, `'\n'`, `'\\''`, `'\x41'`, `'\u{1F600}'` -- and nothing that is
/// really a lifetime.
const CHAR_LITERAL =
  /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|.)|[^\\'])'/;

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
        // A lifetime or a loop label is not a char literal. Treating `'` as
        // the start of one blanked everything up to the next apostrophe, and
        // in daemon/stream.rs the first `'` is `Formatter<'_>` on line 41
        // while the next is `&'a` on line 812 -- so 770 lines, every async fn
        // in the file included, were masked out and silently unscanned. The
        // audit reported a pass over code it had never looked at.
        if (CHAR_LITERAL.test(text.slice(i))) {
          out += " ";
          i += 1;
          state = "char";
        } else {
          out += ch;
          i += 1;
        }
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
