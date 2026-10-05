#!/usr/bin/env node
// The TUI footer has three channels and they mean different things: work under
// way (`set_progress`/`set_busy`), a note spent on the next key (`set_note`),
// and a failure that outlives the key until dismissed (`footer_alert`). Putting
// a message in the wrong one is invisible -- it still renders, just in the wrong
// colour with the wrong lifetime -- which is how `! Restored 9 agents` survived,
// and how a refused action's only explanation was erased by the retry.
//
// So this gate reads the message at every call site and makes the classification
// a decision somebody wrote down. It cannot know intent; it can insist that
// failure words do not end up in a channel a keypress erases, and that progress
// words do not end up in the one painted red.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const allowlistPath = resolve(repoRoot, "scripts/transient-channel-allowlist.json");
const SCAN_ROOT = resolve(repoRoot, "native/crates/aimux/src");

// Words that only appear when something went wrong and stayed wrong.
const FAILURE_WORDS = [
  "error", "Error", "failed", "Failed", "failure", "Failure",
  "could not", "Could not", "Cannot", "cannot", "unavailable",
  "refused", "Refused", "requires",
];
// What only appears while something is still happening. Half of these are
// source idioms rather than prose, because the message is usually interpolated
// -- `format!("Worktree {} is {action}")` spells none of the verbs it prints,
// so matching the rendered words alone would check nothing.
const PROGRESS_WORDS = [
  " is creating", " is still creating", " is removing", " is graveyarding",
  " is starting", " is stopping", " is forking", " is migrating",
  " is switching", " is renaming", " is moving", " is pending",
  "Restoring", "Loading",
  "{action}", "pending_action", "restore_started_message",
];

const NOTE_CALLS = ["set_note(", "set_busy("];
const ALERT_CALLS = ["DashboardFailureAlert::local(", "DashboardFailureAlert::for_action("];

function listRustFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = resolve(directory, entry);
    if (statSync(full).isDirectory()) found.push(...listRustFiles(full));
    else if (entry.endsWith(".rs")) found.push(full);
  }
  return found;
}

/** The argument text of a call starting at `open`, paren-balanced. */
function argumentAt(source, open) {
  let depth = 1;
  let index = open;
  while (depth > 0 && index < source.length) {
    const character = source[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    index += 1;
  }
  return source.slice(open, index - 1);
}

function findCalls(source, needles) {
  const hits = [];
  for (const needle of needles) {
    let index = source.indexOf(needle);
    while (index >= 0) {
      const argument = argumentAt(source, index + needle.length);
      hits.push({ line: source.slice(0, index).split("\n").length, call: needle, argument });
      index = source.indexOf(needle, index + needle.length);
    }
  }
  return hits;
}

const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
// Keyed on the message, not a line number: an edit anywhere above would shift
// a line key and silently move the exemption onto a different call site.
const allowed = allowlist.entries.map((entry) => entry);
const isAllowed = (path, argument) =>
  allowed.some((entry) => entry.file === path && argument.includes(entry.message));
const violations = [];
let scanned = 0;
let classified = 0;

for (const file of listRustFiles(SCAN_ROOT)) {
  const source = readFileSync(file, "utf8");
  // In-file `mod tests` deliberately builds both channels to assert on them.
  const body = source.split("\n#[cfg(test)]\n")[0];
  const path = relative(repoRoot, file);
  scanned += 1;
  for (const hit of findCalls(body, NOTE_CALLS)) {
    const word = FAILURE_WORDS.find((candidate) => hit.argument.includes(candidate));
    if (!word) continue;
    classified += 1;
    if (isAllowed(path, hit.argument)) continue;
    violations.push(
      `${path}:${hit.line}  ${hit.call} carries ${JSON.stringify(word)} -- a failure a keypress erases. Use footer_alert, or classify it in ${relative(repoRoot, allowlistPath)}.`,
    );
  }
  for (const hit of findCalls(body, ALERT_CALLS)) {
    const word = PROGRESS_WORDS.find((candidate) => hit.argument.includes(candidate));
    if (!word) continue;
    classified += 1;
    if (isAllowed(path, hit.argument)) continue;
    violations.push(
      `${path}:${hit.line}  a failure alert carries ${JSON.stringify(word)} -- work in flight painted red and left for the user to dismiss. Use set_busy or set_progress, or classify it.`,
    );
  }
}

if (violations.length > 0) {
  console.error("transient footer channel audit failed:\n");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(`\n${violations.length} message(s) in the wrong channel.`);
  process.exit(1);
}
console.log(
  `transient footer channel audit passed: ${scanned} file(s) scanned, ${classified} classified, ${allowlist.entries.length} allowlisted`,
);
