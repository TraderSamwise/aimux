# Transient Jobs v1

Status: shipped reference

Transient jobs let a local shell start an Aimux-managed, resumable job and then
watch, detach, tail, wait, cancel, or request a notification for it. They are
designed for scripts that need a stable address and replayable status instead
of a one-shot process whose output disappears when the terminal closes.

## Goals

- Run a payload through an explicit tool with a stable job handle.
- Treat the address as the job slot: one live job per address.
- Make repeated equivalent calls join and tail a running job instead of
  duplicating work.
- Refuse a conflicting live job at the same address with an actionable error.
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

Webhook and command callbacks are deferred pending an explicit decision from
Sam, not a hidden TODO in the current feature.

## Commands

Start or join a job:

```sh
aimux run <address> --tool <tool> (--skill <name> | --prompt <text>) [--project <project>] [--detach] [--json] [--notify-fifo <path>] [-- args...]
```

`--tool <tool>` is required. Exactly one payload selector is required:
`--skill <name>` or `--prompt <text>`. Use `--` before job arguments when they
could be parsed as Aimux flags.

Inspect and control jobs:

```sh
aimux job list [--scope <address>] [--depth <n>]
aimux job show <handle>
aimux job tail <handle> [--seq <n>]
aimux job wait <handle> [--seq <n>]
aimux job cancel <handle>
aimux job notify <handle> --watcher-id <id>
aimux attach <handle>
```

`show`, `tail`, `wait`, `cancel`, and `notify` each take exactly one handle.
`list` takes no handle. `--scope` and `--depth` are list-only, `--seq` is for
tail/wait, and `--watcher-id` is notify-only.

`aimux job tail <handle>` streams structured job output. `aimux job wait
<handle>` waits for terminal status, prints nothing, and exits with the job's
own outcome code. `aimux attach <handle>` is a separate top-level verb for
interactive tmux attach/detach.

## Address Grammar

An address identifies a job slot. It does not identify the skill or prompt.

| Address | Meaning |
| --- | --- |
| `global` | The one global job slot. |
| `global/<slot>/...` | Named global job slots at arbitrary depth. |
| `<project>` | The one project job slot. |
| `<project>/<lane>` | The one job slot for that worktree lane, if the second segment is a real lane. |
| `<project>/<slot>/...` | Project-scoped user slots when the second segment is not a real lane. |
| `<project>/<lane>/<slot>/...` | Worktree-scoped user slots beneath a real lane. |

Project names are resolved through the Aimux project registry to a project id.
Equivalent spellings for the same project resolve to the same identity.

Lane-vs-slot precedence is deliberate: if the second segment matches a real
worktree lane for the project, it is a lane. A user cannot create a project slot
whose first segment collides with an existing lane name.

Invalid or reserved forms:

- `global` is reserved as the first segment. If a real project is named
  `global`, address it with `--project <path>` and `.` for the project slot.
- Any address segment starting with `job-` is reserved because job ids use that
  prefix.
- Empty segments, whitespace, `.`, `..`, and unsupported characters are refused
  at creation. Address segments currently allow ASCII letters, digits, `.`,
  `_`, and `-`.

Examples:

```sh
# Global slot with a skill payload.
aimux run global --tool codex --skill daily-check --detach

# Named global slot.
aimux run global/release-watch --tool claude --prompt "watch the release lane"

# Project slot by registered name or id.
aimux run aimux --tool codex --skill smoke -- --fast

# Worktree lane slot. "main" is a lane if it exists for this project.
aimux run aimux/main --tool claude --prompt "review this checkout"

# User-chosen sub-slot under a lane.
aimux run aimux/main/review-pr-123 --tool codex --skill review-pr -- https://github.com/example/repo/pull/123
```

## Identity And Joining

The idempotency key is the resolved address alone. The address is the job slot,
and there can be only one live job at that slot.

Create-or-join has three cases:

- No live job at the address: create the job and stream it.
- A live job at the address with the same spec: join and tail the existing job.
- A live job at the address with a different spec: refuse with exit code 24.

A terminal job at the address is reclaimed and replaced. Recent terminal history
remains addressable by job id until retention removes it.

The conflict refusal names the address, existing job id, running tool and
payload summary, requested tool and payload summary, the differing fields, and
the two safe next commands: `aimux job tail <address>` or `aimux job wait
<address>` to watch what is there, and `aimux job cancel <address>` to stop it.
There is no `--force` or `--replace`.

For logging safety, displayed record fields can be sanitized, while the private
material file keeps the raw execution payload for the runner.

## Payloads

Each job has exactly one payload:

- `--skill <name>` sends the tool the skill invocation, such as `/review-pr`.
- `--prompt <text>` sends the raw prompt text to the tool on stdin.

Raw prompts can contain quotes, newlines, and shell metacharacters. They are
stored in the private `material.json` file and never passed through shell
wrapping or argv. The tmux launch receives only the job id; the internal runner
loads the private material file.

## Listing And Prefix Streams

`aimux job list --scope <address>` is recursive by default. It includes a job at
the address itself and all jobs beneath it.

Depth narrows the recursion:

| Flag | Meaning |
| --- | --- |
| no `--depth` | Unlimited depth. |
| `--depth 0` | Exact address only. |
| `--depth 1` | Address plus direct children. |
| `--depth N` | Address plus up to N additional segments. |

Matching uses resolved address segments, not string prefixes. For example,
`--scope tealstreet-next` does not match a different project named
`tealstreet-next-2`. `--scope global` lists only global slots.

The daemon's job-list stream uses the same predicate as list, so GUI dashboards
that subscribe to a prefix see the same recursive/default-depth behavior as the
CLI.

## Exit Codes

`aimux run`, `aimux job tail`, and `aimux job wait` use these exit codes:

| Code | Meaning |
| ---: | --- |
| 0 | Job succeeded. |
| 1-255 | `aimux job wait` returns the tool's own exit code when the job ran and exited. A signal death follows shell convention, `128 + signal`. |
| 20 | `aimux run` or `aimux job tail` saw a terminal failed job. |
| 21 | Job was cancelled. |
| 22 | The local caller detached on `SIGINT`. |
| 23 | Stream lost before terminal status, including a partial SSE frame. |
| 24 | A different live job already owns the requested address. |
| 1 | Other stream I/O error. |

`Ctrl-C` detaches. It does not cancel the job. Aimux prints that the job is
still running and points at `aimux job cancel`.

## Events, Tail, And Wait

Each job has ordered events with a per-job `seq`. Sequence numbers are 0-based
and gapless. `aimux job tail --seq N <handle>` replays every event whose
sequence is greater than or equal to `N`.

`aimux job wait <handle>` uses the same stream but suppresses event rendering.
It exits with the terminal job outcome, so scripts can wait without keeping a
stdout stream open.

Example resumable tail loop:

```sh
handle="<handle printed by aimux run --detach>"
aimux job tail "$handle" --seq 0

# Later, after recording the last event seq as 42:
aimux job tail "$handle" --seq 43
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

Register a FIFO notification at creation time:

```sh
mkfifo /tmp/aimux-job.done
aimux run aimux/main --tool codex --skill smoke --notify-fifo /tmp/aimux-job.done --detach
```

The FIFO must already exist and must be a FIFO. Aimux writes one JSON line when
the job reaches terminal status. Opening the FIFO is nonblocking; a missing
reader or closed reader is recorded as a delivery failure and does not block the
daemon.

Callback outcomes are durable and visible. Desktop notifications are attempted
up to 5 times, 60 seconds apart, with a 900 second give-up window.

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

### Same Address Means One Live Job

If the same spec is already running at an address, `aimux run` joins it. If a
different spec is already running at that address, `aimux run` refuses with exit
code 24. Use `aimux job tail <address>` or `aimux job wait <address>` when you
want to observe whatever is already there without asserting a spec.

### Lanes Take Precedence Over Slots

At `<project>/<x>`, `x` is a lane when it matches a real worktree lane. This
means users cannot create a project slot whose first segment collides with a
lane name.

### Displayed Spec May Be Sanitized

Records are sanitized for logging. Raw payloads and args live in the private
material file for execution.

### Pending Notifications Extend Retention

Terminal jobs usually age out after 14 days, but a pending notification callback
protects the job until the callback either delivers or gives up, up to 900
seconds beyond the usual window.

## Rejected Designs

### Optional Or Inferred Tool

Rejected. Tool inference makes shell scripts ambiguous and can start the wrong
agent when multiple tools support a skill name. `--tool` is mandatory.

### Skill As The Address Suffix

Rejected. The address is a slot, not a payload. A slot can run a skill or a raw
prompt, and the same address is the stable handle for tail, wait, cancel, and
dashboard subscription.

### Multi-Job Address Identity

Rejected. Tool, payload, args, cwd, and env describe the live job occupying an
address. They do not create parallel live jobs at the same address. A different
live spec at the same address is a conflict, not a new idempotency key.

### Remote Job Routes

Rejected for v1. Jobs are a local loopback control surface. Remote access would
need a separate security design rather than reuse of the current relay paths.

### Webhook Or Command Callbacks

Rejected for v1. Webhooks violate the local network-surface boundary unless an
explicit remote-capable design is approved. Command callbacks would let an
untrusted local process arrange future daemon-uid execution through globally
addressable jobs.
