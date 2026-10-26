# Agent Bug Reports

An agent working inside aimux is often the first thing to notice that aimux is
broken. This is how it says so, and what it may say.

Reporting is **off until you turn it on**. Nothing is recorded while it is off
— not sent, not written. See [Turning it on](#turning-it-on).

## What counts

A report is worth filing when all four are true:

1. **It is aimux that is broken**, not the agent's own task. A test that fails
   because the code is wrong is not a bug report. A `aimux agent input` that
   reports success while the pane shows nothing is.
2. **It is reproducible, or it left evidence.** "It felt slow" is not a report.
   "`aimux ps` took 11s, three times running, and here is the timing" is.
3. **The agent can show it**, within what a report may contain (below). A bug
   that can only be demonstrated by quoting the user's source is not reportable
   — say what aimux did, not what it was working on.
4. **Nobody has filed it.** Reports are deduplicated by fingerprint, so filing
   the same thing twice adds a count rather than a record — but an agent should
   still check before writing prose.

What does not count: a task failure, a disagreement with the user, a missing
feature, a slow model, a flaky external service, anything an agent cannot
distinguish from its own mistake.

## What a report contains

Every field is required unless marked optional. The schema is the redaction:
there is no free-text field large enough to paste a repository into, and the
fields that do take text are capped.

| field | what it is |
|---|---|
| `what` | one line: what aimux did that it should not have, or did not do that it should |
| `surface` | the CLI verb, daemon route, or runtime component involved — `aimux agent input`, `POST /api/commands`, `loop watcher` |
| `expected` | one line |
| `observed` | one line |
| `repro` | the shortest sequence that shows it, as aimux commands |
| `evidence` | optional, capped: the smallest excerpt of **aimux's own** output or logs that shows the failure |
| `build` | filled in automatically: version, build stamp, platform |
| `at` | filled in automatically |

### What a report must never contain

This is the part the opt-in exists for. A report leaves the machine it was
written on, and it is written by an agent that has the user's repository open.

- **No project or file paths.** Not the repo root, not a worktree path, not a
  filename from the user's tree. `surface` names an aimux component; it does
  not name where the agent was working.
- **No file contents** from outside aimux's own state, and no diffs.
- **No environment**, no shell history, no command lines other than the aimux
  commands in `repro`.
- **No credentials, tokens, keys or URLs with secrets in them** — and because
  that cannot be checked reliably, no raw log lines that were not produced by
  aimux itself.
- **No prompts or model output**, the user's or the agent's.
- **No other user's data** in any form.

An agent that cannot describe the bug under these rules should tell the user
about it in the session instead. That is not a failure of the system; it is the
system working.

## Turning it on

Off by default. Nothing is written while it is off, and an agent that tries to
file one is told that reporting is disabled rather than silently succeeding.

```jsonc
// ~/.aimux/config.json
{ "bugReports": { "enabled": true } }
```

## Not spamming

An agent that hits a bug in a loop would otherwise file it every iteration.

- Reports are **deduplicated by fingerprint**, derived from the required
  fields. The same bug twice is one record with a count and a last-seen time.
- Each fingerprint has a **cooldown**: a repeat inside it updates the count and
  nothing else.
- Each machine has a **budget per window**. An agent over budget is told so —
  the answer is never a silent drop, because an agent that believes it filed a
  report will not mention the bug any other way.

## Reading them back

The store is local, one record per line, and self-contained by design: whoever
reads it will usually not have the machine it came from, so a report that says
"see the log" is worth nothing.
