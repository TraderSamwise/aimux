#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const roots = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const scanRoots = roots.length > 0 ? roots.map((root) => resolve(repoRoot, root)) : [resolve(repoRoot, "native/crates/aimux")];

/// Direct filesystem calls that block the thread they run on.
const SYNC_FS_CALLS =
  /\bfs\s*::\s*(read|read_to_string|write|read_dir|metadata|copy|rename|remove_file|remove_dir_all|create_dir_all)\s*\(/;

/// Readers the derivation provably cannot see, because they delegate.
///
/// Kept deliberately short and justified one by one: each holds no `fs::` call
/// of its own, so no amount of seeding on direct calls will find it, and each
/// was named by the hand list this derivation replaced. Adding to this list
/// should feel like a defeat -- check first whether the reader can simply be
/// found.
const DELEGATING_STATE_READERS = new Set([
  "load_metadata_state",
  "try_load_metadata_state",
  "load_topology",
  "read_agent_input_delivery_queue",
]);

/// The sync filesystem readers, DERIVED from the crate instead of listed.
///
/// This replaces a hand-maintained list of eight names. That list was the
/// honest cost of the hazard and it was also wrong: a scan found 218 sync
/// functions in this crate that read a file directly, 14 reachable from an
/// async body, and only THREE of the fourteen named. `load_last_used_date`
/// style omissions are not hypothetical -- `load_topology` was missing, so
/// `load_control_model_async` read as fixed when only half of it was, and
/// later `load_last_used_state` was still inline in a route this audit called
/// clean.
///
/// A bare name match on its own is useless: it reports hundreds of hits,
/// because `new` and `run` and `write` are everywhere. TWO RULES make the
/// derivation attributable, and both are statements about what this scanner
/// can PROVE rather than lists of names that look generic:
///
/// 1. SCOPE. Rust requires a called function to be in scope, so a name counts
///    only where the calling file defines it or names it in a `use`.
/// 2. ONE DEFINITION, NO ASYNC TWIN. A name defined as a sync filesystem
///    reader in more than one place cannot be attributed to any of them --
///    that is what drops `new`, which has 13 such definitions. And a name that
///    also exists as an `async fn` cannot be attributed to the sync one,
///    because this crate pairs sync and async siblings under one name
///    everywhere; that is what drops `run`, whose call in
///    `deliver_staged_prompt_async` is awaited.
///
/// What those rules exclude, they exclude loudly: `--explain-suppressed` lists
/// every call they declined to claim, so the blind spot is inspectable instead
/// of implied. Method calls are the real remaining limit -- a bare name cannot
/// tell `host.execute(...)` from a free function, which is why the gh-pr-context
/// tick's four per-tick reads were found by reading rather than by this scan.
function deriveSyncFilesystemReaders(files) {
  const definedIn = new Map();
  const asyncNames = new Set();
  const fileTexts = new Map();

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    fileTexts.set(file, text);
    const masked = maskRust(text);
    for (const match of masked.matchAll(
      /(?:^|\n)[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(async[ \t]+)?fn[ \t]+([A-Za-z_][A-Za-z0-9_]*)/g,
    )) {
      const isAsync = Boolean(match[1]);
      const name = match[2];
      if (isAsync) {
        asyncNames.add(name);
        continue;
      }
      // The body, bounded by brace depth from the declaration.
      const from = match.index + match[0].length;
      let depth = 0;
      let began = false;
      let end = masked.length;
      for (let i = from; i < masked.length; i += 1) {
        const ch = masked[i];
        if (ch === "{") {
          depth += 1;
          began = true;
        } else if (ch === "}") {
          depth -= 1;
          if (began && depth <= 0) {
            end = i;
            break;
          }
        }
      }
      // A DELEGATING wrapper reaches the filesystem through another function,
      // so its own body holds no `fs::` call and the derivation cannot see it.
      // These four are named because the hand list this derivation replaced
      // named them, and dropping them was a real loss of coverage:
      // `load_metadata_state` is one call to
      // `load_metadata_state_at_unix_millis`, and the other three are the same
      // shape.
      //
      // I tried deriving them instead, twice, and measured both: a transitive
      // closure over callers amplifies the generic-name problem rather than
      // containing it -- one sync `run` that touches a file made every caller
      // named `run` a reader -- and restricting propagation to attributable
      // edges still classified the hop HELPERS as readers, flagging the very
      // functions that exist to take these reads off the worker. A short list
      // of names the scanner provably cannot derive is the honest cost; it is
      // four entries rather than the eight it replaced, and the rest is
      // derived.
      if (DELEGATING_STATE_READERS.has(name) || SYNC_FS_CALLS.test(text.slice(from, end))) {
        if (!definedIn.has(name)) definedIn.set(name, new Map());
        // Keyed by SITE, not by file. Keying by file counted two definitions
        // in one file as one, so a name that is ambiguous within a single
        // module read as attributable.
        definedIn.get(name).set(`${file}:${match.index}`, file);
      }
    }
  }

  const attributable = new Map();
  const suppressed = new Map();
  for (const [name, where] of definedIn) {
    if (where.size > 1) {
      suppressed.set(name, `${where.size} sync definitions`);
    } else if (asyncNames.has(name)) {
      suppressed.set(name, "has an async sibling of the same name");
    } else {
      attributable.set(name, [...where.values()][0]);
    }
  }
  return { attributable, suppressed, fileTexts };
}

/// A call to a FREE function of this name, never a method call on a receiver.
///
/// The derivation finds `fn NAME` at module level, so that is all it can claim.
/// Without this the gate matches `.store(true, Ordering::SeqCst)` against a
/// module function called `store` -- and `store`, `load`, `write` and `list`
/// are all attributable names in this crate, while atomics appear in async
/// bodies constantly. Only the scope rule was keeping that quiet, which is far
/// too thin for something that fails a build.
///
/// The cost is stated rather than hidden: a reader reached through a METHOD
/// call is invisible here. That is how the gh-pr-context tick hid four
/// per-tick reads behind `host.execute(...)`, and it was found by reading the
/// function, not by this scan. Including method calls is useful for hunting
/// and too noisy to gate on.
function freeCallRegex(name) {
  return new RegExp(`(?<![.\\w])${name}\\s*\\(`);
}

let DERIVED_READERS = null;

/// Whether `fnSource` calls a derived sync reader that is in scope in `file`.
///
/// Returns the name so a failure can say which reader it means, and records
/// what it declined to claim for `--explain-suppressed`.
const suppressedHits = [];
function derivedReaderCalledInScope(fnSource, file) {
  if (!DERIVED_READERS) return null;
  const { attributable, suppressed, fileTexts } = DERIVED_READERS;
  const text = fileTexts.get(file) ?? "";
  for (const [name, definedFile] of attributable) {
    if (!freeCallRegex(name).test(fnSource)) continue;
    const inScope =
      definedFile === file || new RegExp(`^\\s*(pub )?use .*\\b${name}\\b`, "m").test(text);
    if (inScope) return name;
  }
  for (const [name, why] of suppressed) {
    if (freeCallRegex(name).test(fnSource)) {
      suppressedHits.push({ file, name, why });
    }
  }
  return null;
}


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
    // A synchronous read of a project state file on an async worker: the
    // hazard this whole family of fixes was about.
    //
    // It catches the readers it NAMES, which is less than the whole class --
    // see `SYNC_STATE_READERS`. A pass here is not a guarantee that no async
    // body reads a file synchronously. The project service runs TWO
    // workers, so two of these at once is the entire runtime -- the same shape
    // as the interceptor that killed daemons, reached from a different
    // direction.
    //
    // TWO PATTERNS, because one is not enough. Direct `fs::` calls are the
    // obvious half, and on its own that half would have caught NONE of the
    // twelve production sites this landed with: they all went through
    // project-level wrappers like `read_runtime_topology`. So the wrappers are
    // named too, the way `std-net` names its types.
    //
    // The named list is the maintenance cost and it is the honest cost: a
    // wrapper nobody adds here is a site the audit calls clean. That happened
    // during the cleanup -- `load_topology` was missing, so
    // `load_control_model_async` read as fixed when only half of it was, and
    // `route_open_dashboard_async` never appeared at all. Add the name when a
    // new sync reader appears.
    //
    // Work already ON the pool is the fix rather than the hazard, so the
    // `spawn_blocking_named` closures are stripped first -- without that this
    // flags the very helpers that exist to hop these reads.
    id: "sync-fs",
    message:
      "synchronous state-file read inside an async body; take it inside spawn_blocking_named",
    matches: (fnSource, _fileText, filePath) => {
      const body = fnSource.replace(/spawn_blocking_named\s*\([\s\S]*?\n\s{4,}\)/g, " ");
      if (SYNC_FS_CALLS.test(body)) return true;
      return derivedReaderCalledInScope(body, filePath) !== null;
    },
  },
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
const allRustFiles = scanRoots.flatMap(rustFiles);
DERIVED_READERS = deriveSyncFilesystemReaders(allRustFiles);
for (const file of allRustFiles) {
  const text = readFileSync(file, "utf8");
  for (const fn of asyncBodies(text)) {
    if (hasSeamMarker(text, fn.start, fn.end)) continue;
    for (const hazard of HAZARDS) {
      if (!hazard.matches(fn.source, maskRust(text), file)) continue;
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

// What the attribution rules declined to claim. The derivation's blind spot is
// inspectable rather than implied: every call it saw and would not attribute is
// listed here with the reason.
if (process.argv.includes("--explain-suppressed")) {
  const seen = new Set();
  console.log(`derived readers: ${DERIVED_READERS.attributable.size} attributable, ${DERIVED_READERS.suppressed.size} unattributable`);
  // The blast radius worth eyeballing: a SHORT attributable name is where a
  // false positive would hide, since matching is by bare name.
  const shortest = [...DERIVED_READERS.attributable.keys()]
    .sort((left, right) => left.length - right.length)
    .slice(0, 12);
  console.log(`  shortest attributable names: ${shortest.join(", ")}`);
  for (const hit of suppressedHits) {
    const key = `${hit.file}:${hit.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  not claimed: ${relative(repoRoot, hit.file)} calls ${hit.name} (${hit.why})`);
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
