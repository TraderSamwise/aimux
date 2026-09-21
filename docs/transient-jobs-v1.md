# Transient Jobs v1

Status: shipped reference

Transient jobs let a local shell start an Aimux-managed, resumable job and then
watch, detach, reattach, cancel, or request a desktop notification for it. They
are designed for scripts that need a stable handle and replayable status instead
of a one-shot process whose output disappears when the terminal closes.

## Goals

- Run a named skill through an explicit tool with a stable job handle.
- Make repeated equivalent calls join a running job instead of duplicating work.
- Let scripts detach and later resume event output from a known sequence number.
- Keep job invocation local-only; remote clients cannot start, cancel, or read
  jobs.
- Retain enough status, material, event, and callback state to inspect recent
  jobs without letting old terminal jobs grow without bound.

## Non-Goals

- Remote job invocation. Jobs are not available through relay, web, mobile, or
  any remote actor path.
- Webhook callbacks. An outbound HTTP callback from the local daemon to a
  user-supplied URL would violate the local-only network-surface gate by design:
  the dependency graph excludes remote HTTP clients such as `ureq` outside the
  remote-control boundary.
- Command callbacks. A command callback would be privilege laundering: the
  loopback daemon has no local authentication and jobs are globally addressable,
  so any local process could register a command that later runs as the daemon
  uid against someone else's job.
- Inferred tools. `--tool` is mandatory; Aimux does not guess from the address,
  positional args, project, cwd, or installed CLIs.
- Address fallback to the current working directory. Project-scope shorthand
  requires `--project`.

Webhook and command callbacks are deferred pending an explicit decision from
Sam, not a hidden TODO in the current feature.

## Commands

Start or join a job:

```sh
aimux run <address> --tool <tool> [--project <project>] [--detach] [--json] [-- args...]
```

`--tool <tool>` is required. There is no default and no positional tool sniffing.
Use `--` before job arguments when they could be parsed as Aimux flags.

Inspect and control jobs:

```sh
aimux job list [--scope <scope>]
aimux job show <handle>
aimux job attach <handle> [--seq <n>]
aimux job cancel <handle>
aimux job notify <handle> --watcher-id <id>
aimux attach <handle>
```

`show`, `attach`, `cancel`, and `notify` each take exactly one handle. `list`
takes no handle. `--scope` is list-only, `--seq` is attach-only, and
`--watcher-id` is notify-only. `aimux attach <handle>` is a separate top-level
verb for attaching to a job handle.

## Address Grammar

An address identifies scope plus skill:

| Address | Meaning |
| --- | --- |
| `<skill>` | Project-scope skill. Requires `--project`; no cwd fallback. |
| `global/<skill>` | Global-scope skill. |
| `<project>/<skill>` | Project resolved through the registry by name or id. |
| `<project>/<lane>/<skill>` | Project and lane resolved through the registry by name or id. |

Invalid or reserved forms:

- `global/<x>/<y>` is an error.
- `global` is reserved. If a real project is named `global`, address it with
  `--project` rather than the address prefix.

Examples:

```sh
# Project shorthand: --project is required.
aimux run summarize --project /Users/sam/cs/aimux --tool codex -- --since HEAD~1

# Global skill.
aimux run global/daily-check --tool codex --detach

# Project by registered name or id.
aimux run aimux/smoke --tool claude -- --fast

# Project lane by registered name or id.
aimux run aimux/release/readiness --tool codex --json
```

## Identity And Joining

Aimux computes the idempotency key as a SHA-256 over:

- scope identity
- skill
- tool
- args
- cwd
- env

The key uses the project id, not the project name. It does not include caller
identity, timestamp, `--detach`, or `--json`.

This has two important consequences:

- A second caller with the same full spec joins a running job instead of
  starting another one.
- If the existing job is terminal, the index entry is reclaimed and a fresh job
  starts. "Same address twice" means join while running, re-run after finish.

The address is not the whole identity. A different `--tool` is a completely
different job and can run concurrently. The same is true for any change to args,
cwd, or env. Callers often assume the address alone is the identity; it is not.
The whole hashed spec is the identity.

For logging safety, displayed record fields can be sanitized, while the
idempotency key hashes the raw values.

## Exit Codes

`aimux run` and attach-style streams use these exit codes:

| Code | Meaning |
| ---: | --- |
| 0 | Job succeeded. |
| 20 | Job failed. |
| 21 | Job was cancelled. |
| 22 | The local caller detached on `SIGINT`. |
| 23 | Stream lost before terminal status, including a partial SSE frame. |
| 1 | Other stream I/O error. |

`Ctrl-C` detaches. It does not cancel the job. Aimux prints that the job is
still running and points at `aimux job cancel`.

## Events And Attach

Each job has ordered events with a per-job `seq`. Sequence numbers are 0-based
and gapless. `aimux job attach --seq N <handle>` replays every event whose
sequence is greater than or equal to `N`.

The `seq` guarantee is for events. The output tap is byte-offset based, not
event-sequence based.

Example resumable attach loop:

```sh
handle="<handle printed by aimux run --detach>"
aimux job attach "$handle" --seq 0

# Later, after recording the last event seq as 42:
aimux job attach "$handle" --seq 43
```

If the stream ends before terminal status, including because of a partial SSE
frame, the command exits 23. Treat that as unknown stream state and reattach by
handle rather than assuming the job ended.

## Cancellation And Notifications

Cancel a job explicitly:

```sh
aimux job cancel "$handle"
```

Detaching does not cancel. `--detach` returns after creating or joining the job.
`Ctrl-C` detaches from an attached stream. Only `aimux job cancel` requests job
cancellation.

Register a desktop notification callback:

```sh
aimux job notify "$handle" --watcher-id "release-readiness-terminal"
```

There is exactly one callback kind: `DesktopNotification`. It is keyed by
`watcher-id`, with outcomes:

- `Created`
- `Existing`
- `Rearmed`

Delivery is attempted up to 5 times, 60 seconds apart, with a 900 second
give-up window.

## Storage And Retention

Job state lives under the global Aimux dir:

```text
<global aimux dir>/jobs/
  index/<key>.json
  records/<job-id>/
    status.json
    material.json
    events.ndjson
    callbacks.json
    output.tap
```

The job store is created private.

Retention limits:

- `max_jobs`: 1000
- `max_events_per_job`: 1000
- terminal job retention: 14 days

Pruning:

- removes terminal jobs past the cutoff or beyond the 1000 newest jobs
- truncates only terminal event logs
- reaps orphan index entries

A pending callback protects a job from both terminal retention removal and
event-log truncation until the callback give-up bound abandons it. That means a
job with an undelivered callback can outlive the stated 14 day retention window
by up to 900 seconds. If the callbacks file is unreadable, retention fails
closed and keeps the job.

## Security Boundary

Jobs are not remotely invocable.

All job routes are loopback-only. They return HTTP 403 with
`job routes are loopback-only` when an actor header is present. The job SSE
stream rejects the same way.

The relay cannot launder job requests because it stamps the forwarded actor
header over any peer-supplied value; the forwarded request still receives 403
and no job is created. Remote, relay, web, and mobile clients cannot start,
cancel, read, or attach to a job.

## Sharp Edges

### Detach Does Not Kill

Neither `--detach` nor `Ctrl-C` stops a job. They only stop the local stream.
Use `aimux job cancel <handle>` to request cancellation.

### Same Spec Joins While Running

If a matching job is running, a second caller joins it. If the previous matching
job is terminal, a new job starts. This is intentional idempotency, not a lock.

### Tool, Args, Cwd, And Env Are Part Of Identity

These two commands are different jobs and can run concurrently:

```sh
aimux run aimux/smoke --tool codex
aimux run aimux/smoke --tool claude
```

So are calls that change args, cwd, or env. Do not treat the displayed address
as the complete idempotency identity.

### Displayed Spec May Be Sanitized

Records are sanitized for logging. The key hashes raw values. If a displayed
field is redacted, that does not mean the redacted value was used for identity.

### Pending Notifications Extend Retention

Terminal jobs usually age out after 14 days, but a pending desktop notification
callback protects the job until the callback either delivers or gives up, up to
900 seconds beyond the usual window.

## Rejected Designs

### Optional Or Inferred Tool

Rejected. Tool inference makes shell scripts ambiguous and can start the wrong
agent when multiple tools support a skill name. `--tool` is mandatory.

### Cwd Fallback For `<skill>`

Rejected. `<skill>` requires `--project` so a script cannot accidentally run
against whatever checkout happens to be current.

### Address-Only Idempotency

Rejected. The address alone does not capture the actual work. Tool, args, cwd,
and env materially change the job and belong in the idempotency key.

### Remote Job Routes

Rejected for v1. Jobs are a local loopback control surface. Remote access would
need a separate security design rather than reuse of the current relay paths.

### Webhook Or Command Callbacks

Rejected for v1. Webhooks violate the local network-surface boundary unless an
explicit remote-capable design is approved. Command callbacks would let an
untrusted local process arrange future daemon-uid execution through globally
addressable jobs.
