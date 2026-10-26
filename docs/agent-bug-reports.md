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
| `build` | filled in automatically: the aimux version |
| `at` | filled in automatically |
| `machineId` | filled in automatically: the opaque id from `machine.json`, never the machine's name, which is a hostname |
| `tool` | filled in automatically: which agent tool was running, reduced to a short lowercase word or `unknown` |

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
  aimux itself. The automatic fields are held to the same rule: `tool` comes
  from the agent's own environment, which the agent controls, so it is reduced
  to a short lowercase word or recorded as `unknown`.
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

An agent that hits a bug in a loop would otherwise file it every iteration,
and two agents hitting the same bug would file it twice.

- Reports are **deduplicated by fingerprint** — the four one-line fields, and
  deliberately not the repro or the evidence, which differ between two agents
  hitting the same thing. The same bug is one record with a count and a
  last-seen time, and a repeat changes only those two: the first filing's
  detail is the one somebody will read.
- Each machine may hold a **fixed number of distinct bugs**. The budget is on
  distinct bugs rather than on sightings, because a sighting of something
  already on file costs nobody any triage.
- Each bug is recorded a **fixed number of times** and then not again. The
  store is append-only, so a sighting costs a line and an agent in a loop would
  otherwise grow the file without bound. Past that, the agent is told the bug
  is already recorded: the count stops rising because nothing more is being
  learned, not because anyone stopped listening.
- An agent that is refused is **told why**, whether the refusal is the opt-in,
  a missing field, or a full machine. The answer is never a silent drop,
  because an agent that believes it filed a report will not mention the bug any
  other way.

The store is append-only and a bug is a group of lines sharing a fingerprint.
The first design kept one record per bug and rewrote it in place, which has a
lost-update race: two agents filing two different new bugs at the same moment
each read a store without the other's line, and whichever wrote second erased
the other's report. A lost count would have been tolerable; a lost report is
not. The per-fingerprint cooldown this section once specified went with that
design -- the sighting cap above is what bounds growth now.

## Filing one

```bash
aimux bug report \
  --what "input reported success while the pane stayed empty" \
  --surface "aimux agent input" \
  --expected "the text appears in the agent's composer" \
  --observed "the route answered ok and the composer was empty" \
  --repro "aimux agent input --session codex-1 --text hello" \
  --evidence "verified: false"
```

There is no `--context`, `--log`, `--file` or `--project`, and an unknown flag
is refused rather than ignored. The tool the report is attributed to is read
from the agent's environment rather than taken as an argument — which does not
make it trustworthy, since an agent's own shell sets that environment, so it is
reduced to a short lowercase word or recorded as `unknown`.

Filing is local and needs no daemon, which matters because an agent is most
likely to have something to report about aimux exactly when the daemon is down.

## Reading them back

```bash
aimux bug list            # one line per bug, with how often it was seen
aimux bug list --json
```


The store is local, one line per sighting, and self-contained by design:
whoever reads it will usually not have the machine it came from, so a report
that says "see the log" is worth nothing.

Nothing ever removes a line. A line that cannot be read — an append cut short
by a crash, a foreign writer — is skipped, logged, and **counted**. That is the
opposite of hiding it: refusing the whole store over one bad line would be
worse, because filing reads the store first, so a single bad line would stop
every future report as well as every read.

`aimux bug list` reports two counts, because there are two ways a line can go
unshown. Some cannot be read at all. Others read perfectly well but belong to
no bug — no fingerprint, or a bug whose first sighting is gone, that sighting
being the only one that carries the report body. Reporting only the first
would show fewer sightings than the file holds and say nothing about the
difference.
