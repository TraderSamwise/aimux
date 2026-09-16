# Local-Only Data At Rest And Exfiltration Audit

Audit workstream: `gqaapg-138`

Date: 2026-09-16

Audience: corporate security reviewers evaluating whether an Aimux build can be
accepted as provably local-only.

## Scope Boundary

This audit covers the Aimux binary/control plane: the daemon, per-project
service, tmux runtime integration, CLI, dashboard state, and files Aimux writes.

This audit does not claim the machine is offline. Aimux launches user-selected
agent CLIs such as `claude`, `codex`, and `aider`. Those processes are separate
network clients that may talk to Anthropic, OpenAI, package registries, git
forges, and other services. A local-only Aimux build can at most prove that
Aimux itself does not upload Aimux-managed data. The spawned agents remain a
separate user and corporate trust decision.

The existing lite boundary currently proves only that the `remote-control` Cargo
feature is absent from the lite binary. It does not prove that disk state is
private, retained for an acceptable period, excluded from Git, or covered by a
data-exfiltration allowlist.

## Evidence Commands

The following commands were run from Sam's machine. They inspect code and
metadata only; they do not restart daemons, services, dashboards, or agent
sessions.

```bash
sed -n '1,260p' native/crates/aimux/src/paths.rs
sed -n '1,560p' native/crates/aimux/src/project_service/attachments.rs
sed -n '1,370p' native/crates/aimux/src/attachment_hosting.rs
sed -n '1,330p' native/crates/aimux/src/project_service/graveyard_cleanup.rs
sed -n '1,330p' native/crates/aimux/src/project_service/runtime_health_history.rs
sed -n '1,180p' native/crates/aimux/src/recording_cleanup.rs
sed -n '1,260p' native/crates/aimux/src/config.rs
sed -n '1,260p' native/crates/aimux/src/atomic_write.rs
sed -n '1,140p' native/crates/aimux/src/remote_credentials.rs
sed -n '120,210p' scripts/check-lite-build-boundary.sh
sed -n '3860,3910p' native/crates/aimux/src/daemon/runtime.rs
```

```bash
find /Users/sam/cs/aimux/.aimux -maxdepth 2 -type d -print0 \
  | xargs -0 stat -f '%Sp %Su:%Sg %z %N'

find /Users/sam/cs/aimux/.aimux/context \
     /Users/sam/cs/aimux/.aimux/history \
     /Users/sam/cs/aimux/.aimux/plans \
     /Users/sam/cs/aimux/.aimux/status \
     /Users/sam/cs/aimux/.aimux/attachments \
     -maxdepth 2 -type f -print0 \
  | xargs -0 stat -f '%Sp %Su:%Sg %z %N'

find /Users/sam/.aimux -maxdepth 3 -type d -print0 \
  | xargs -0 stat -f '%Sp %Su:%Sg %z %N'

find /Users/sam/.aimux -maxdepth 3 -type f -print0 \
  | xargs -0 stat -f '%Sp %Su:%Sg %z %N'
```

```bash
du -sh /Users/sam/cs/aimux/.aimux/context \
       /Users/sam/cs/aimux/.aimux/history \
       /Users/sam/cs/aimux/.aimux/plans \
       /Users/sam/cs/aimux/.aimux/status \
       /Users/sam/cs/aimux/.aimux/attachments \
       /Users/sam/.aimux/daemon \
       /Users/sam/.aimux/projects
```

Observed sizes in the live Aimux checkout:

```text
1.0M  /Users/sam/cs/aimux/.aimux/context
2.4M  /Users/sam/cs/aimux/.aimux/history
356K  /Users/sam/cs/aimux/.aimux/plans
8.0K  /Users/sam/cs/aimux/.aimux/status
23M   /Users/sam/cs/aimux/.aimux/attachments
53M   /Users/sam/.aimux/daemon
648M  /Users/sam/.aimux/projects
```

Representative live counts in `/Users/sam/cs/aimux/.aimux`:

```text
context     152 files
history      34 files
plans        88 files
status        2 files
attachments 170 files
```

## Findings

### 1. Sensitive project data is world-readable by default on this machine

Severity: high.

Scenario: a second local account, endpoint-security tool, backup agent, or
over-broad support collection can read agent transcripts, summaries,
attachments, task threads, project roots, and worktree names without needing
Aimux privileges.

Evidence:

- Live project-local directories under `/Users/sam/cs/aimux/.aimux` are
  `drwxr-xr-x`.
- Live transcript, context, plan, status, and attachment files are `-rw-r--r--`.
- Live home-level state under `/Users/sam/.aimux/projects` and daemon logs is
  also mostly `drwxr-xr-x` and `-rw-r--r--`.
- `native/crates/aimux/src/atomic_write.rs` creates files with no mode override
  unless callers explicitly pass one.
- `native/crates/aimux/src/project_service/attachments.rs` writes attachment
  bytes and metadata through `atomic_write` / `write_json_atomic`, with no
  owner-only mode.
- `native/crates/aimux/src/debug_logging.rs` appends logs with
  `OpenOptions::create(true).append(true)` and no owner-only mode.

Positive counterexample: `~/.aimux/auth.json` is `-rw-------`, and
`native/crates/aimux/src/remote_credentials.rs` writes it with
`atomic_write_with_mode(..., Some(0o600))`. The codebase knows how to create
owner-only state; the sensitive transcript/attachment/state stores do not use
that mechanism consistently.

A provable local-only corporate build should fail if any sensitive Aimux store
is created with group/world-readable bits. No such gate exists today.

### 2. Project `.aimux` data can leak into Git commits in repositories without an outer ignore

Severity: high.

Scenario: a developer runs Aimux in a corporate repo that does not already
ignore `.aimux/`, then commits from a normal Git UI or broad pathspec. Agent
history, summaries, plans, status files, and attachments can be staged.

Evidence from a temporary repo with global excludes disabled:

```bash
tmp=$(mktemp -d /tmp/aimux-ignore-audit.XXXXXX)
git -C "$tmp" init -q
git -C "$tmp" config core.excludesFile /dev/null
mkdir -p "$tmp/.aimux/attachments" "$tmp/.aimux/history"
cp /Users/sam/cs/aimux/.aimux/.gitignore "$tmp/.aimux/.gitignore"
printf 'secret attachment\n' > "$tmp/.aimux/attachments/a.txt"
printf '{}\n' > "$tmp/.aimux/history/s.jsonl"
git -C "$tmp" status --short --untracked-files=all
git -C "$tmp" add -n .aimux/attachments/a.txt .aimux/history/s.jsonl .aimux/.gitignore
```

Observed output:

```text
?? .aimux/.gitignore
?? .aimux/attachments/a.txt
?? .aimux/history/s.jsonl
add '.aimux/.gitignore'
add '.aimux/attachments/a.txt'
add '.aimux/history/s.jsonl'
```

The generated `.aimux/.gitignore` is useful only after Git is already reading
ignore rules inside `.aimux`. It is not a first-use containment boundary for an
untracked `.aimux/` directory. In Sam's Aimux repo, this is masked by a root
`.gitignore` rule and a user-global ignore rule, but those are not properties of
Aimux in an arbitrary corporate checkout.

### 3. Attachments are retained as raw plaintext files and are not covered by generated ignore rules

Severity: high.

Scenario: a user attaches a screenshot, source file, generated report, or other
work artifact. Aimux copies the bytes into `.aimux/attachments`; the attachment
record stores the original filename, MIME type, SHA-256, absolute content path,
session id, size, creation time, and optionally relay-hosting metadata.

Evidence:

- `native/crates/aimux/src/project_service/attachments.rs` stores attachment
  content at `.aimux/attachments/{id}{extension}` and metadata at
  `.aimux/attachments/{id}.json`.
- Live attachment metadata contains keys:
  `contentPath`, `createdAt`, `filename`, `hostedAttachment`, `id`, `kind`,
  `mimeType`, `sessionId`, `sha256`, `sizeBytes`, and `source`.
- The live Aimux checkout has 170 attachment files totaling 23 MB.
- Live attachments are `-rw-r--r--`.
- `native/crates/aimux/src/config.rs` generates `.aimux/.gitignore` entries for
  `context/`, `history/`, `tasks/`, `status/`, `threads/`, `recordings/`,
  `plans/`, `worktrees/`, and `state.json`; it does not list `attachments/`.

There is useful source validation: path-published attachments must be regular
files, under the project/worktree/temp roots, at most 10 MB, and the filename is
blocked if it looks like a credential or secret file. That reduces accidental
credential attachment, but it does not make the attachment store private or
self-cleaning.

### 4. `~/.aimux/projects/*` stores corporate work metadata outside the repo

Severity: medium-high.

Scenario: a corporate reviewer approves project-local `.aimux` exclusions but
misses the home-level project state. Aimux still stores project roots, worktree
paths, session IDs, commands, args, runtime exchange messages, notification
state, and health/log data under the user's home directory.

Evidence from `/Users/sam/.aimux/projects/tealstreet-next-208154504245`:

- `metadata.json` has a `sessions` object; session entries include `context`,
  `derived`, `progress`, `statusline`, and `updatedAt`.
- `metadata.json` session `context` includes `branch`, `cwd`, `repo`,
  `transcriptPath`, `worktreeName`, and `worktreePath`.
- `graveyard.json` entries include `id`, `tool`, `toolConfigKey`, `command`,
  `args`, and `worktreePath`.
- `runtime-exchange.yaml` contains task/thread/message records with
  participants, titles, message ids, unread state, tags, and task content.
- `notifications.json`, `work-outline.json`, `runtime-topology.yaml`,
  `dashboard-operation-failures.json`, and per-client dashboard UI files are
  present.
- `shell-integration` contains shell configuration and history files such as
  `.zsh_history`, `.zshenv`, and `.zshrc`.
- Live home-level project state is mostly `-rw-r--r--` and `drwxr-xr-x`.

This state is not in the project checkout, so Git ignores do not address it.
It is also not deleted when a developer stops thinking about a project; several
project directories and large runtime health logs were present.

### 5. Context and history contain source-work conversations with no automatic retention limit found

Severity: medium-high.

Scenario: an agent session discusses source code, build failures, credentials
by accident, or internal architecture. Aimux stores raw JSONL history plus
derived summaries. Months later, those files still exist and are readable by
other local users.

Evidence:

- Real `.aimux/history/*.jsonl` files contain timestamped prompt/response/git
  events and terminal/chat output.
- Real `.aimux/context/*/summary.md` files contain generated summaries of agent
  work, files modified, decisions, errors, blockers, branches, install labels,
  and command outcomes.
- `native/crates/aimux/src/context_compactor.rs` reads from
  `.aimux/history/{session}.jsonl` and writes `summary.md`,
  `summary.meta.json`, and `summary.checkpoints.jsonl`.
- I found compaction and checkpointing logic, but not deletion of raw history or
  context summaries based on age or project policy.

### 6. Some stores do have bounded retention, but the sensitive stores are inconsistent

Severity: medium.

Evidence:

- Graveyard cleanup defaults to enabled with 14-day retention in
  `native/crates/aimux/src/config.rs`; cleanup planning in
  `native/crates/aimux/src/project_service/graveyard_cleanup.rs` removes
  expired graveyarded agents/worktrees only when the cleanup route/task runs.
- Runtime exchange compaction exists in
  `native/crates/aimux/src/project_service/exchange_retention.rs`, retaining
  bounded numbers of notification threads, workflow threads, closed tasks, and
  message bodies.
- Runtime health is a rotating JSONL log using the shared log limits
  `10_000_000` bytes x 5 files, and tests assert this covers more than 21 days
  at maximum sample size.
- Recording cleanup defaults to enabled with 30-day retention in
  `native/crates/aimux/src/recording_cleanup.rs`, and refuses cleanup if live
  session state cannot be read.
- General debug logs rotate at 10 MB x 5 files by default when logging is
  enabled.

Gaps:

- Attachments have no age or size retention beyond the per-file upload cap.
- Raw `.aimux/history` and generated `.aimux/context` summaries have no age
  retention found in this audit.
- `~/.aimux/projects/*` directories accumulate state across projects and test
  runs; I found many historical project directories.

### 7. Lite exfiltration is only partially provable today

Severity: medium.

What is proven by existing checks:

- `scripts/check-lite-build-boundary.sh` builds/checks the lite variant with
  `--no-default-features`.
- It fails if the lite Cargo tree contains `tokio-tungstenite`, `tungstenite`,
  or `ureq`.
- It fails if lite `--help` exposes `remote`, `hosted`, `login`, `logout`,
  `whoami`, or `security` commands.
- It fails if lite binary strings contain relay/remote markers such as
  `AIMUX_RELAY_URL`, `wss://relay.aimux.app`, `relay_client`,
  `tokio-tungstenite`, `tungstenite`, or `ureq`.
- In source, attachment relay hosting is behind `#[cfg(feature =
  "remote-control")]`; the non-remote stub returns
  `AttachmentHostingResult::Skipped`.

What is not yet proven:

- There is no dedicated gate that enumerates sensitive stores and fails if a
  lite binary opens any outbound path from those stores.
- There is no runtime network-denied proof in this audit for "Aimux did real
  local work while no non-loopback egress occurred." That evidence belongs to
  the network-surface workstream and was requested from `codex-v987zd`. An
  `aimux host agent-read` attempt failed with `invalid daemon HTTP response:
  missing header terminator`, so this document does not cite that workstream as
  completed evidence.
- There is no mutation proof that adding an upload from `.aimux/context`,
  `.aimux/history`, `.aimux/attachments`, `~/.aimux/projects/*/metadata.json`,
  or logs would fail a data-exfiltration gate. The current lite boundary would
  likely catch some relay/remote regressions, but it is not expressed as a
  sensitive-data exfiltration policy.

## Storage Inventory

| Location | Actual contents observed | Permissions observed | Git exposure | Retention/deletion |
| --- | --- | --- | --- | --- |
| `.aimux/context` | Live terminal snapshots, LLM summaries, summary metadata and checkpoints, date-based markdown context | dirs `0755`, files `0644` | Protected in this repo by root/global ignore; not protected by generated `.aimux/.gitignore` before `.aimux` itself is ignored | No age deletion found |
| `.aimux/history` | JSONL prompt/response/git/tool history for sessions | dir `0755`, files `0644` | Same as context | No age deletion found |
| `.aimux/plans` | Agent plan markdown, including task names and goals | dir `0755`, files `0644` | Same as context | No age deletion found |
| `.aimux/status` | Agent status markdown | dir `0755`, files `0644` | Same as context | No age deletion found |
| `.aimux/attachments` | Raw attachment bytes plus JSON metadata | dir `0755`, files `0644` | Not listed in generated `.aimux/.gitignore`; can be staged in a repo without root/global `.aimux/` ignore | No age deletion found |
| `.aimux/tasks`, `.aimux/threads` | Project-local coordination state | dirs `0755`; content not exhaustively sampled | Listed in generated ignore, but same first-use caveat applies | Runtime exchange has compaction; local files need caller-specific review |
| `.aimux/recordings` | Terminal recordings | dir `0755` | Listed in generated ignore, but same first-use caveat applies | Recording cleanup default 30 days when enabled/running |
| `.aimux/worktrees` | Managed Git worktrees, full source checkouts | dirs `0755` | Listed in generated ignore, but worktrees are real Git checkouts | Worktree graveyard cleanup defaults 14 days |
| `~/.aimux/auth.json` | Relay URL, daemon token, user id, remote-enabled flag | file `0600` | Outside repo | Removed by logout/credential clear |
| `~/.aimux/daemon` | Daemon state, daemon info, large rotating JSONL/stdout logs | dirs `0755`, files mostly `0644` | Outside repo | JSON logs rotate; state/backups/tmp can remain |
| `~/.aimux/projects/<id>` | Per-project service state, metadata, topology, graveyard, notifications, runtime exchange, dashboard UI state, logs, shell integration, plugin cache | dirs `0755`, files mostly `0644`; some hot snapshots `0600` | Outside repo | Mixed: graveyard 14 days, runtime exchange compacts, runtime health rotates, many state files remain |
| `~/.aimux/hosted` | Hosted/remote mode principals, audit, devices, lockdown/outbox paths by resolver | not fully sampled here | Outside repo | Several hosted files use `0600` and hosted dirs use `0700` in code |
| `/tmp` and temp dirs | Build/test temp dirs, cargo target dirs, script temp output, launchd sweep stdout/stderr paths | inherited from creating process | Outside repo | Usually caller/script lifecycle; not an Aimux sensitive-store policy |

## Exfiltration Assessment For Lite

Current honest verdict: **not yet provably local-only for data**.

The lite build has meaningful remote-control absence evidence, and the specific
attachment hosting upload path is compiled to a no-op when `remote-control` is
absent. That supports a narrow claim: the lite Aimux binary should not contain
the existing relay remote-control client or relay attachment upload code.

That is not enough for a corporate data-at-rest/exfiltration claim. The current
gates do not enumerate all sensitive disk stores, do not enforce owner-only
permissions, do not prove first-use Git exclusion, and do not fail on a new
non-relay uploader that reads context/history/attachments/logs.

## Required Gates Before Claiming "Provably Local-Only"

1. Sensitive-store permission gate.

   Create an isolated project and `AIMUX_HOME`; exercise `aimux init`,
   attachment upload/publish, history/context writes, project service state,
   logs, graveyard, runtime exchange, and hosted/auth paths. Assert sensitive
   directories are `0700` and sensitive files are `0600`, except intentionally
   executable code artifacts. Mutation proof: change `atomic_write`/directory
   creation or an attachment writer back to umask-default `0644`/`0755` and the
   gate fails.

2. Git-leak gate.

   In a temporary Git repo with `core.excludesFile=/dev/null`, initialize Aimux
   and create representative `.aimux/context`, `.aimux/history`,
   `.aimux/attachments`, `.aimux/plans`, `.aimux/status`, `.aimux/tasks`,
   `.aimux/threads`, `.aimux/recordings`, and `.aimux/worktrees` files. Assert
   `git add -n .aimux/...` cannot stage any sensitive generated data. Mutation
   proof: remove the outer `.aimux/` ignore or `attachments/` rule and the gate
   fails.

3. Sensitive-store egress gate.

   Maintain an explicit list of sensitive stores and run static plus runtime
   checks for lite:

   - `.aimux/context`
   - `.aimux/history`
   - `.aimux/plans`
   - `.aimux/status`
   - `.aimux/tasks`
   - `.aimux/threads`
   - `.aimux/attachments`
   - `.aimux/recordings`
   - `~/.aimux/auth.json`
   - `~/.aimux/daemon`
   - `~/.aimux/projects`
   - `~/.aimux/hosted`
   - Aimux logs and temp spools

   The gate should fail if lite contains outbound HTTP/WebSocket/DNS clients or
   if any new outbound route reads from those stores. Mutation proof: add a
   test-only or feature-guarded uploader from `.aimux/attachments` or
   `.aimux/history` and verify the lite boundary fails.

4. Runtime network-denied gate.

   Run a real lite binary in an isolated runtime while loopback is allowed and
   non-loopback egress is denied/monitored. Exercise project discovery,
   dashboard/service startup, agent inventory without launching network agent
   CLIs, attachment storage, context/history read/write, graveyard read/write,
   and doctor/reporting. Assert no non-loopback connection attempt by the Aimux
   process tree except explicitly excluded user agent CLIs. Mutation proof: add
   a non-loopback request in Aimux code and the gate fails.

5. Retention gate.

   Assert that each sensitive store has a declared retention policy and a test
   proving deletion or compaction. Mutation proof: disable attachment/history
   cleanup or runtime exchange compaction and the gate fails.

## Coordination Notes

- Network-surface evidence was requested from `codex-v987zd`; this report does
  not rely on it because the response was not available during this audit.
- Build-lane gate candidates were sent to `codex-5kqar5` for `gqaapg-140`.
- Execution/supply-chain overlap was acknowledged to the `gqaapg-139`
  workstream; relevant data findings are permissions, config/env persistence,
  logs, plugin cache, shell-integration files, and spawned-agent trust boundary.

## Bottom Line

Aimux currently writes sensitive source-work data in plaintext under both the
project checkout and `~/.aimux`. On the audited machine, most of those files are
group/world-readable. Project-local data is protected from commits in Sam's repo
by repo/global ignore rules, but Aimux's generated ignore is not a sufficient
first-use protection in an arbitrary corporate repo. Lite builds remove the
existing remote-control/relay code path, including relay attachment hosting, but
there is not yet a data-specific exfiltration gate with mutation proof.

The correct security-review position today is: **lite Aimux has remote-control
compiled out, but Aimux is not yet provably local-only for data at rest or data
exfiltration.**
