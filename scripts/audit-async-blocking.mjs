#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const roots = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const scanRoots = roots.length > 0 ? roots.map((root) => resolve(repoRoot, root)) : [resolve(repoRoot, "native/crates/aimux")];

const NET_TYPES = ["TcpListener", "TcpStream", "UdpSocket", "UnixListener", "UnixStream"];

/// The net type names a file binds BARE from `<module>::net`.
///
/// An aliased import does not bind the bare name, so `TcpStream as
/// StdTcpStream` is not in the result. A glob binds all of them.
function bareNetImports(fileText, module) {
  const names = new Set();
  if (new RegExp(`\\buse\\s+${module}\\s*::\\s*net\\s*::\\s*\\*`).test(fileText)) {
    for (const type of NET_TYPES) names.add(type);
    return names;
  }
  const regex = new RegExp(
    `\\buse\\s+${module}\\s*::\\s*net\\s*::\\s*(\\{[^}]*\\}|[A-Za-z_][A-Za-z0-9_]*(?:\\s+as\\s+[A-Za-z_][A-Za-z0-9_]*)?)`,
    "g",
  );
  for (const match of fileText.matchAll(regex)) {
    const spec = match[1];
    const items = spec.startsWith("{") ? spec.slice(1, -1).split(",") : [spec];
    for (const item of items) {
      const trimmed = item.trim();
      if (trimmed.length === 0 || /\bas\b/.test(trimmed)) continue;
      if (NET_TYPES.includes(trimmed)) names.add(trimmed);
    }
  }
  return names;
}

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
    // A bare `TcpListener::` means whichever module imported that name bare,
    // and one file cannot import two types of the same name bare. So the
    // imports decide, and asking only whether `use std::net::` appears
    // SOMEWHERE in the file does not: `local_ui_server.rs` imports std's
    // `TcpStream` under an alias, tokio's `TcpListener` and `TcpStream` bare,
    // calls `std::net::TcpListener::bind` fully qualified outside the async
    // work and tokio's `TcpListener::from_std` bare inside it. Every bare name
    // in that file is tokio's, and the old test called the correct one a
    // violation.
    //
    // A fully qualified `std::net::` path is unambiguous and still fires
    // whatever the imports say.
    //
    // KNOWN GAP, deliberately not closed here: std's type reached through an
    // ALIAS (`StdTcpStream::connect`) is not detected, because the alias is
    // not one of the names below. Closing that means following the alias, and
    // it is a different change from fixing a false positive.
    id: "std-net",
    message: "std::net used inside async fn; use tokio::net or spawn_blocking",
    matches: (fnSource, fileText) => {
      if (/\bstd\s*::\s*net\b/.test(fnSource)) return true;
      const fromStd = bareNetImports(fileText, "std");
      const fromTokio = bareNetImports(fileText, "tokio");
      return NET_TYPES.some(
        (type) =>
          new RegExp(`\\b${type}\\s*::`).test(fnSource) &&
          !fromTokio.has(type) &&
          fromStd.has(type),
      );
    },
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

/// Does this body carry a seam marker?
///
/// Reads the RAW text, because `maskRust` blanks comments -- and its
/// replacements are length-preserving, so offsets into the masked text index
/// the raw text as well. The marker is looked for inside the body and on the
/// few lines above it, which is where `block_on_named` callers already put it.
///
/// A marker of its OWN, not the async-seams one, and that was not the first
/// try. I reused `aimux-async-seam:` on the argument that one annotation read
/// by two audits beats two conventions -- and the seams audit refused it with
/// "stale async seam marker has no adjacent seam", correctly. That marker
/// exists to account for a `block_on` call, sync code driving async, which is
/// migration debt; its staleness check enforces that every marker sits next to
/// one. "This block_on boundary is accounted for" and "this blocking call
/// inside an async body is deliberate" are different claims about different
/// code, so conflating them was the error and the check caught it.
///
/// Same four classifications, for familiarity:
/// `aimux-async-blocking: test - the sleep is the fixture`.
function hasSeamMarker(rawText, start, end) {
  // Six lines, because a marker worth reading usually explains itself over a
  // few of them and sits directly above the body. Bounded on purpose: a
  // marker further away than this is not plainly attached to the code it
  // would excuse.
  let windowStart = start;
  for (let line = 0; line < 6 && windowStart > 0; line += 1) {
    windowStart = rawText.lastIndexOf("\n", windowStart - 1);
    if (windowStart === -1) {
      windowStart = 0;
      break;
    }
  }
  const window = rawText.slice(Math.max(windowStart, 0), end);
  return /aimux-async-blocking:\s*(?:permanent|transitional|test|fixture)\s+-\s*\S/.test(window);
}

/// Every async body, not only the ones spelled `async fn`.
///
/// The extractor matched `async fn` and nothing else, and the shape it missed
/// is the one the scheduler is built from: `PeriodicTask::run` is a PLAIN `fn`
/// returning `Box::pin(async move { .. })`, because the trait returns a boxed
/// future. Measured on the crate: 73 such bodies, none of which any hazard had
/// ever been applied to -- so `std::process`, `std::net`, `thread::sleep`, the
/// shared-mutex hold and a blocking recv were all unenforced inside every
/// periodic task in the project service.
///
/// Same FAMILY as the masker bug: a pass reported over code never looked at.
/// A different cause -- there the mask blanked 770 lines, here the body was
/// never selected -- and the measurement is why this is a commit rather than a
/// claim.
function asyncBodies(text) {
  const masked = maskRust(text);
  const matches = [];

  const fnRegex = /\basync\s+(?:unsafe\s+)?(?:extern\s+(?:[A-Za-z_][A-Za-z0-9_]*|"[^"]*")\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of masked.matchAll(fnRegex)) {
    const openBrace = masked.indexOf("{", match.index + match[0].length);
    if (openBrace === -1) continue;
    const end = findBodyEnd(masked, openBrace);
    matches.push({
      name: match[1],
      start: match.index,
      end,
      openBrace,
      source: masked.slice(match.index, end),
    });
  }

  const blockRegex = /\basync\s+(?:move\s+)?\{/g;
  for (const match of masked.matchAll(blockRegex)) {
    const openBrace = masked.indexOf("{", match.index + match[0].length - 1);
    if (openBrace === -1) continue;
    const end = findBodyEnd(masked, openBrace);
    // A block that IS an async fn's body is already collected; reporting it
    // again would name one hazard twice for the same code.
    if (matches.some((fn) => match.index >= fn.openBrace && end <= fn.end)) continue;
    matches.push({
      name: enclosingFunctionName(masked, match.index) ?? "async block",
      start: match.index,
      end,
      openBrace,
      source: masked.slice(match.index, end),
    });
  }

  return matches;
}

/// The nearest `fn NAME` above an offset, so a failure names something a
/// reader can find rather than a line number alone.
function enclosingFunctionName(masked, offset) {
  const match = [...masked.slice(0, offset).matchAll(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g)].pop();
  return match ? match[1] : null;
}

const violations = [];
for (const file of scanRoots.flatMap(rustFiles)) {
  const text = readFileSync(file, "utf8");
  for (const fn of asyncBodies(text)) {
    if (hasSeamMarker(text, fn.start, fn.end)) continue;
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
