# aimux

Native CLI agent multiplexer — run multiple AI coding tools side-by-side with their native TUIs intact.

aimux uses `tmux` as its terminal runtime substrate. Each project gets its own managed tmux runtime session, each terminal gets its own dashboard client session/window, and each agent runs in its own tmux window while aimux keeps orchestration, worktrees, plans, and metadata on top.

## Features

- **tmux-backed runtime** — real scrollback, attach/detach, repaint, and terminal compatibility come from tmux instead of a custom multiplexer
- **Dashboard clients** — each terminal gets its own dashboard tmux client session/window while agent runtime stays shared per project
- **Agent windows** — each agent gets its own tmux window with its native TUI intact
- **tmux status integration** — the native tmux status line shows aimux session, task, headline, and metadata state
- **Metadata API** — scripts and agents can push status, progress, logs, and notifications into the tmux status line
- **Plugin/watcher seam** — local plugins can watch files or external tools and publish metadata without patching aimux core
- **Leader key switching in dashboard** — `Ctrl+A` prefix for dashboard actions like create/kill/switch while you are in the aimux dashboard window
- **Dashboard view** — see all running, offline, and remote agents at a glance
- **Multi-instance** — run aimux in multiple terminal tabs; agents from other instances appear inline and can be taken over
- **Agent lifecycle** — two-step kill (`[x]` stops → offline, `[x]` again → graveyard), with `aimux graveyard resurrect` for recovery
- **Task delegation** — agents can delegate work to each other via `.aimux/tasks/`, with automatic dispatch, completion notifications, and dashboard badges
- **Threaded orchestration** — direct messages, handoffs, and task assignment all flow through durable `.aimux/threads/` state with queued delivery when recipients are busy
- **Dashboard orchestration actions** — from the main dashboard, use `S` to send a message, `H` to send a handoff, `T` to assign a task, `o` to jump to the most relevant thread, and `R` to reply when something is waiting on you
- **Workflow view** — a dedicated workflow screen groups related task/review/revision chains, supports actionable filters, and exposes explicit accept/block/complete/reopen/review controls
- **Next-action guidance** — dashboard rows and details surface `on me`, `blocked`, family-chain pressure, and the single most relevant next orchestration step
- **Context sharing** — agents can read each other's conversation history via `.aimux/context/`
- **Session resume** — resume previous sessions using each tool's native resume (`--resume`) or injected history (`--restore`)
- **Git worktree support** — first-class worktree management for parallel feature work, with per-worktree agent isolation
- **Fully config-driven** — all tool behavior (prompt detection, session capture, resume, compaction) is declarative config, not code
- **Configurable** — global (`~/.aimux/config.json`) and project-level (`.aimux/config.json`) configuration with deep merge
- **Notifications** — cross-platform notifications (macOS, Linux, Windows) when agents need attention or complete tasks
- **Project event stream** — each project service exposes an SSE stream for ephemeral alerts and other live GUI/web events
- **Custom instructions** — `~/AIMUX.md` (global) and `./AIMUX.md` (project) are injected into every agent's preamble

## Install

```bash
# Clone and build
git clone https://github.com/TraderSamwise/aimux.git
cd aimux
yarn install
yarn build

# Link globally
yarn link
```

Requires Node.js >= 18 and `tmux` in `PATH`.

## Quick Start

```bash
# Launch dashboard for this terminal client
aimux

# Launch a specific tool in a new tmux agent window
aimux claude
aimux codex
aimux aider

# Resume all offline sessions
aimux --resume
```

The per-project tmux session is the long-lived runtime substrate. Aimux no longer tries to build its own PTY multiplexer on top of native TUIs.

## Architecture

Aimux now distinguishes between:

- `tmux` runtime
- global aimux control-plane daemon
- daemon-managed project services
- terminal/desktop/service clients

`tmux` still owns the actual agent runtime:

- agent windows
- PTYs
- scrollback
- attach/detach

The global daemon owns shared control-plane responsibilities:

- project discovery and activation
- supervision of daemon-managed project services
- desktop/service-facing project discovery

Each active project may have one daemon-managed project service. That project service owns:

- metadata API lifecycle
- plugin runtime
- project `statusline.json` writing
- project-scoped control-plane sidecars

There is no per-project host election anymore. Dashboard processes are clients, not control-plane owners.

Desktop/Tauri now talks to the live control plane directly:

- daemon HTTP is used for project discovery / service discovery
- project-service HTTP is used for live project state and awaited lifecycle actions
- `statusline.json` remains a derived artifact for tmux/status/debugging, not the desktop's primary transport
- desktop loading state should clear on heartbeat reconciliation of the expected state change, not on HTTP return alone

Terminal clients are isolated from each other:

- the shared per-project tmux runtime session owns agent windows
- each terminal gets its own tmux client session and dashboard window
- dashboard tab, pointer, and load state are terminal-local
- orchestration, metadata, and plugin sidecars are project-scoped through the daemon-managed project service

Useful commands:

```bash
aimux daemon ensure
aimux daemon status --json
aimux daemon projects --json
aimux daemon project-ensure --project /abs/path/to/repo

# Compatibility wrapper: ensure the current project's control service
aimux serve
```

Orchestration commands:

```bash
aimux message send "Need UI review on the login flow" --assignee ui --worktree /abs/path/to/worktree
aimux handoff send "Take over the sidebar polish from here" --tool claude
aimux task assign "Audit the websocket reconnect path" --assignee reviewer
aimux handoff accept <threadId>
aimux handoff complete <threadId>
aimux task accept <taskId>
aimux task block <taskId> --reason "Waiting on API decision"
aimux task complete <taskId>
aimux task reopen <taskId>
aimux review approve <taskId>
aimux review request-changes <taskId> --body "Handle reconnect backoff edge cases"
aimux thread list
```

GUI-facing lifecycle commands:

```bash
# Fresh agent using the same spawn flow as the dashboard
aimux spawn --tool claude --project /abs/path/to/repo --worktree /abs/path/to/worktree --json

# Fork an existing live agent with handed-off context
aimux fork <sessionId> --tool codex --project /abs/path/to/repo --worktree /abs/path/to/worktree --json

# Match the dashboard lifecycle
aimux stop <sessionId> --project /abs/path/to/repo --json
aimux rename <sessionId> --label "Backend reviewer" --project /abs/path/to/repo --json
aimux migrate <sessionId> --worktree /abs/path/to/worktree --project /abs/path/to/repo --json
aimux kill <sessionId> --project /abs/path/to/repo --json
aimux graveyard send <sessionId> --project /abs/path/to/repo --json
aimux graveyard resurrect <sessionId> --project /abs/path/to/repo --json

# Project-scoped worktree helpers
aimux worktree list --project /abs/path/to/repo --json
aimux worktree create feature-x --project /abs/path/to/repo --json

# Focus a live agent in tmux
desktop terminal focus now uses the thin tmux fast-control entrypoint via the project service and terminal client tty
```

HTTP-backed agent I/O helpers:

```bash
# Send raw input to a running agent through the project service
aimux host agent-send <sessionId> "hello\r"
printf 'hello\r' | aimux host agent-send <sessionId> --stdin

# Read a tmux pane snapshot for a running agent
aimux host agent-read <sessionId> --start-line -80

# Stream live pane output over SSE through the project service
aimux host agent-stream <sessionId> --start-line -80 --interval-ms 250
```

Ephemeral project events:

```bash
# Subscribe to per-project alerts/events over SSE
curl -N http://127.0.0.1:<project-service-port>/events
```

These commands are additive control-plane helpers on top of the existing `aimux -> tmux -> codex/claude` runtime. They do not replace the native TUI path; they reuse the same session write path and tmux pane capture path through the project HTTP service.

For desktop / GUI callers, prefer explicit `--project` usage instead of relying on launcher cwd.

Structured message parts:

- `POST /agents/input` accepts either plain `data` or ordered `parts`.
- `parts` currently supports:
  - `{ "type": "text", "text": "..." }`
  - `{ "type": "image", "path": "/abs/path.png", "alt": "..." }`
  - `{ "type": "image", "url": "https://...", "alt": "..." }`
  - `{ "type": "image", "attachmentId": "att_123", "alt": "..." }`
- Parts preserve inline ordering for GUI / HTTP callers.
- Today, tmux-backed agent sessions still receive image parts as explicit inline image descriptors in the prompt text. This preserves message structure now, but it is not yet binary image upload/attachment transport.

Example:

```json
{
  "sessionId": "claude-1",
  "parts": [
    { "type": "text", "text": "Compare these two layouts." },
    { "type": "image", "url": "https://example.com/a.png", "alt": "first screenshot" },
    { "type": "text", "text": "The spacing issue is around the header." }
  ],
  "submit": true
}
```

Control-plane health:

- The desktop UI now surfaces daemon / project-service health and exposes a `Restart control` action.
- The tmux statusline shows `ctl ok`, `ctl daemon↓`, or `ctl stale`.
- `ctl stale` means the project-service `statusline.json` snapshot has stopped updating, which usually means the project service died.
- Manual recovery is still:

```bash
aimux daemon restart
cd /abs/path/to/repo
aimux host restart --serve
```

Daemon rebuild quirk:

- The global daemon and each project service run from the built `dist/` output, not directly from `src/`.
- If you change project-service HTTP behavior, rebuild first with `yarn build`.
- If a daemon is already running, restart the daemon too, not just the project service, or the old daemon will keep spawning old project-service code.

```bash
yarn build
aimux daemon restart
cd /abs/path/to/repo
aimux host restart --serve
```

The desktop app now exposes these flows directly over daemon/project-service HTTP:

- dashboard worktree/agent management
- spawn, fork, rename, migrate, stop, kill
- graveyard browse + resurrect
- worktree create + remove
- activity, workflow, threads, plans, and graveyard secondary screens
- direct message compose, handoff send/accept/complete, and task/review workflow actions
- thread state updates and per-message delivery visibility

For the current source of truth, see [docs/current-architecture.md](docs/current-architecture.md).
For desktop UI integration details, see [docs/desktop-ui-contract.md](docs/desktop-ui-contract.md).
For the migration rationale, see [docs/global-control-plane-rfc.md](docs/global-control-plane-rfc.md).

## Tmux Compatibility

Aimux treats tmux as a managed runtime, not a transparent pass-through. For aimux-owned tmux sessions, aimux applies a fixed compatibility contract instead of inheriting whatever ambient tmux defaults happen to exist on the machine.

Managed session policy today:

- `prefix = C-a`
- `prefix2 = C-b`
- `mouse = on` so tmux can own wheel events and enter pane scrollback reliably
- `extended-keys = always`
- `extended-keys-format = csi-u`
- `terminal-features` includes `xterm*:extkeys`
- `terminal-features` includes `xterm*:hyperlinks`
- managed Claude/Codex windows get `allow-passthrough = on`
- managed Claude/Codex windows get scoped modified-enter bindings for multiline input compatibility
- managed Claude/Codex windows remap wheel-up into tmux copy-mode scrollback instead of forwarding it into the app

This is why aimux can support features like `Ctrl+J`, `Shift+Enter`, and reliable tmux-native wheel scrollback inside managed tmux sessions without depending on user-specific tmux configuration.

To inspect the live state for the current project:

```bash
aimux doctor tmux
aimux doctor tmux --json
```

That reports:

- terminal environment like `TERM` and `TERM_PROGRAM`
- tmux version and current client session
- observed managed-session options versus expected values
- required terminal features such as `extkeys` and `hyperlinks`
- active-window state including `@aimux-tool` and `allow-passthrough`

## Hotkeys

Hotkey latency note:

- dynamic tmux hotkeys now use a thin `tmux-fast-control` entrypoint that talks to the live project service
- the final window switch still happens in tmux
- this avoids spawning the heavyweight operator CLI for normal `n/p/s/u/d` navigation
- the broader latency architecture plan is documented in [docs/latency-architecture-rfc.md](docs/latency-architecture-rfc.md)
- the current entrypoint split is documented in [docs/latency-entrypoints.md](docs/latency-entrypoints.md)

Dashboard hotkeys use the `Ctrl+A` leader prefix:

| Key | Action |
|---|---|
| `Ctrl+A c` | Create new agent |
| `Ctrl+A x` | Stop agent (→ offline) or kill offline agent (→ graveyard) |
| `Ctrl+A w` | Create new worktree |
| `Ctrl+A W` | Worktree management |
| `Ctrl+A v` | Request code review for active agent |
| `Ctrl+A 1-9` | Focus agent by number from the dashboard |
| `Ctrl+A d` | Return to dashboard window |
| `Ctrl+A Ctrl+A` | Send literal Ctrl+A inside the dashboard |

When you are inside an agent window, tmux owns the terminal. Use normal tmux window navigation or run `aimux` again to return to the dashboard window.

Main dashboard orchestration shortcuts:

| Key | Action |
|---|---|
| `S` | Send direct message from the selected agent row |
| `H` | Send handoff from the selected agent row |
| `T` | Assign task from the selected agent row |
| `o` | Jump to the most relevant thread for the selected agent |
| `R` | Open quick reply when that agent has something waiting on you |

Workflow screen shortcuts:

| Key | Action |
|---|---|
| `f` | Cycle workflow filters: all / waiting on me / blocked / families |
| `a` | Accept selected handoff |
| `c` | Complete selected handoff |
| `b` | Mark selected thread blocked |
| `x` | Mark selected thread done |
| `P` | Approve selected review |
| `J` | Request changes on selected review |
| `E` | Reopen selected task chain |

Recommended tmux mental model:

- the shared project runtime session owns agent windows
- each terminal gets its own dashboard client session/window
- aimux metadata, plans, worktrees, and task orchestration sit on top of that runtime

For normal tmux users outside aimux, the equivalent setup usually lives in `~/.tmux.conf`. Aimux just codifies that policy inside its own managed sessions so behavior is stable across projects and terminals.

## Tmux Status Line

Aimux now uses tmux's native status bar instead of an in-terminal custom footer.

The managed tmux session config renders:

- **left**: aimux project identity
- **middle**: native tmux window list
- **right**: aimux session/task/headline/flash metadata

This keeps the terminal surface fully tmux-native while still surfacing the old footer's useful information.

Status rendering has two practical data paths that must stay visually aligned:

- the rich path from `statusline.json` written by the daemon-managed project service
- the fallback path from live tmux window metadata

When extending the footer/status UI, treat both as first-class render sources. The fallback path must carry enough metadata to render the same identity, role, and activity state as the richer dashboard-written path, otherwise the status bar will visibly flicker between styles during updates.

For future tool wiring and continuity expectations, see [docs/tool-integration.md](docs/tool-integration.md).

## Metadata API

Inspired by opensessions, aimux exposes a small project-local metadata API from the daemon-managed project service. The tmux status line reads this state and shows it for the active session.

CLI helpers:

```bash
aimux metadata endpoint
aimux metadata set-status <session> "Deploying" --tone warn
aimux metadata set-progress <session> 3 10 --label services
aimux metadata log <session> "Tests passed" --source ci --tone success
aimux metadata clear-log <session>
```

The project-service HTTP API also exposes:

- `GET /health`
- `GET /state`
- `POST /set-status`
- `POST /set-progress`
- `POST /log`
- `POST /clear-log`
- `POST /notify`

Use `aimux metadata endpoint` to get the local base URL for the current project service.

## Plugins And Watchers

Aimux can load local metadata plugins from:

- `~/.aimux/plugins/*.js|*.mjs`
- `.aimux/plugins/*.js|*.mjs`

Each plugin default-exports a factory:

```js
export default function (api) {
  return {
    start() {
      api.metadata.setStatus("codex-abc123", "Watching", "info");
    },
    stop() {}
  };
}
```

Available API today:

- `api.projectRoot`
- `api.projectId`
- `api.serverHost`
- `api.serverPort`
- `api.metadata.setStatus(session, text, tone?)`
- `api.metadata.setProgress(session, current, total, label?)`
- `api.metadata.log(session, message, { source?, tone? })`
- `api.metadata.clearLog(session)`

Built-in watchers already publish:

- `.aimux/status/{session-id}.md` first-line headline as metadata status
- `.aimux/plans/{session-id}.md` checkbox completion as metadata progress

## Dashboard

When you run `aimux` without arguments, aimux ensures the project tmux session exists and switches you to the dashboard window showing all agents across all states:

```
         aimux — agent multiplexer
──────────────────────────────────────

  ● [1] claude — running ←
  ● [2] codex — idle
  ○ [3] claude — offline
  ◈ [4] claude — other tab (PID 54321)

──────────────────────────────────────
 ↑↓ select  Enter focus  [c] new  [x] stop  [q] quit
```

- **Enter** on a running agent switches to that agent's tmux window
- **Enter** on an offline agent resumes it
- **Enter** on a remote agent (other tab) takes it over
- **`[x]`** on running → stops to offline; **`[x]`** on offline → sends to graveyard

With worktrees, agents are grouped:

```
   (main) — active
    ● [1] claude — running ←

   fix-auth (fix-auth) — active
    ● [2] claude — running
    ○ [3] codex — offline

──────────────────────────────────────
 ↑↓ worktrees  Enter step in  [c] new  [w] worktree  [q] quit
```

## Context System

aimux records each agent's conversation and makes it available to other agents:

- **`.aimux/context/{session-id}/live.md`** — rolling window of recent turns
- **`.aimux/context/{session-id}/summary.md`** — compacted history
- **`.aimux/context/{session-id}/summary.meta.json`** — summary provenance (source range + digest)
- **`.aimux/context/{session-id}/summary.checkpoints.jsonl`** — append-only compaction checkpoints
- **`.aimux/history/{session-id}.jsonl`** — full raw conversation log
- **`.aimux/plans/{session-id}.md`** — canonical shared plan for that agent
- **`.aimux/sessions.json`** — all running agents (so agents can discover each other)

Agents are told about these files in their startup preamble.

These are the canonical agent-facing paths. Runtime-private state stays under `~/.aimux/projects/<project-id>/...` and is not part of the agent contract.

In tmux mode, live terminal state comes from tmux itself. `~/.aimux/projects/<project-id>/state.json` is mainly for offline/resume metadata, not live screen ownership.

Memory roles are explicit:

- `history/*.jsonl` is append-only audit history and is never compacted away
- `context/*/live.md` is bounded runtime scratch state maintained by aimux from tmux pane snapshots
- `context/*/summary.md` is a derived, lossy summary for long-horizon memory
- `summary.meta.json` and `summary.checkpoints.jsonl` preserve compaction provenance so summaries can be traced back to the underlying raw history

## Fork And Migrate Semantics

Aimux treats `fork` and `migrate` as related but distinct operations:

- `fork`
  - always creates a new session id
  - seeds the new session with carried-over `.aimux/context/`, `.aimux/history/`, `.aimux/plans/`, and `.aimux/status/` artifacts
  - opens a handoff thread between source and target
- `migrate`
  - preserves the same aimux session id
  - prefers native backend resume when the tool truly supports it
  - otherwise falls back to aimux-owned continuity injection from history/live context

Tool behavior differs:

- `Claude`
  - supports clean preamble injection
  - does **not** support backend-session-id resume in the way aimux originally assumed
  - so `fork` and fallback `migrate` rely on aimux-owned continuity artifacts
- `Codex`
  - supports backend-session-id resume, so `migrate` usually takes the native resume path
  - does **not** currently have a clean startup handoff flag, so `fork` uses seeded files plus an auto-submitted first-turn kickoff

For deeper details, see [docs/tool-integration.md](docs/tool-integration.md).

## Shared Plans

Aimux standardizes planning per agent/session:

- **Canonical path:** `.aimux/plans/{session-id}.md`
- **Primary key:** session ID, not worktree
- **Purpose:** lets agents read, audit, annotate, and continue each other's plans without main-checkout/worktree edge cases

Each new session gets a stub plan file. Agents are instructed to keep it current using:

- `Goal`
- `Current Status`
- `Steps`
- `Notes`

## Task Delegation

Agents can delegate work to each other through the aimux task system. This is a file-based protocol — agents create task files, aimux dispatches them, and agents report results.

### How it works

1. **Agent A** creates a task file in `.aimux/tasks/`:
   ```json
   {
     "id": "add-login-form",
     "status": "pending",
     "assignedBy": "claude-abc123",
     "description": "Add a login form component",
     "prompt": "Create a React login form at src/components/LoginForm.tsx with email and password fields, validation, and submit handler.",
     "createdAt": "2025-01-15T10:30:00Z",
     "updatedAt": "2025-01-15T10:30:00Z"
   }
   ```

2. **Aimux detects** the pending task (checks every 2s) and finds an idle agent to handle it

3. **The task prompt is injected** into the target agent's stdin — the agent sees it as input and starts working

4. **The agent completes the work** and updates the task file with `"status": "done"` and a `"result"` summary

5. **Aimux notifies** the original agent that the task is complete

### Targeting

Tasks can be targeted in three ways:

- **Specific agent**: set `assignedTo` to a session ID from `.aimux/sessions.json`
- **By tool type**: set `tool` to `"claude"`, `"codex"`, or `"aider"` — dispatched to the first idle agent of that type
- **Any idle agent**: omit both fields — dispatched to any available idle agent

### Dashboard indicators

- Sessions with active tasks show a purple `⧫` badge with the task description
- The dashboard footer shows task counts: `[T:2p/1a]` (2 pending, 1 assigned)
- Flash notifications appear when tasks are assigned, completed, or failed

### Using it

Just ask your agent to delegate. The preamble tells agents exactly how the protocol works. For example:

> "Delegate the test writing to another agent"

> "Hand off the CSS cleanup to the codex agent"

The agent will create the task file, and aimux handles the rest. This is separate from any native task system in the underlying tools (like Claude Code's internal tasks).

## Custom Instructions

Create an `AIMUX.md` file to inject instructions into every agent:

- **`~/AIMUX.md`** — global instructions (applied to all projects)
- **`./AIMUX.md`** — project-specific instructions

Both are read and appended to the preamble (global first, then project).

## Configuration

Initialize project config:

```bash
aimux init
```

This creates `.aimux/config.json`. You can also create a global config at `~/.aimux/config.json`. Project config overrides global, which overrides defaults.

```json
{
  "defaultTool": "claude",
  "runtime": {
    "tmux": {
      "sessionPrefix": "aimux"
    }
  },
  "notifications": {
    "enabled": true,
    "onPrompt": true,
    "onError": true,
    "onComplete": true
  },
  "tools": {
    "claude": {
      "command": "claude",
      "args": ["--dangerously-skip-permissions"],
      "enabled": true
    }
  }
}
```

Tmux runtime:

- `sessionPrefix` — deterministic prefix used for managed per-project tmux sessions

### Tool Configuration

All tool behavior is config-driven. No tool-specific code exists in the multiplexer — adding or customizing a tool only requires config:

```json
{
  "tools": {
    "my-tool": {
      "command": "my-tool",
      "args": ["--some-flag"],
      "enabled": true,
      "preambleFlag": ["--system-prompt"],
      "resumeArgs": ["--resume", "{sessionId}"],
      "resumeFallback": ["--continue"],
      "sessionIdFlag": ["--session-id", "{sessionId}"],
      "sessionCapture": {
        "dir": "{home}/.my-tool/sessions/{yyyy}/{mm}/{dd}",
        "pattern": "([0-9a-f-]+)\\.json$",
        "delayMs": 2000
      },
      "promptPatterns": ["^> $", "^\\$ $"],
      "turnPatterns": ["^[>❯]\\s*(.+)"],
      "compactCommand": "claude --print --output-format text",
      "instructionsFile": "AGENTS.md"
    }
  }
}
```

| Field | Purpose |
|---|---|
| `preambleFlag` | Flag to inject system prompt (e.g. `["--append-system-prompt"]`) |
| `resumeArgs` | Args to resume a session, with `{sessionId}` placeholder |
| `resumeFallback` | Fallback resume args when session ID is unavailable |
| `sessionIdFlag` | Flag to set session ID at spawn time |
| `sessionCapture` | Filesystem-based session ID capture (dir, regex pattern, delay) |
| `promptPatterns` | Regex patterns for idle/prompt detection in status bar |
| `turnPatterns` | Regex patterns for extracting conversation turns from output |
| `compactCommand` | Shell command for LLM-powered history compaction |
| `instructionsFile` | File to write preamble to (for tools without system prompt flags) |

## Multi-Instance

Run aimux in multiple terminal tabs for the same project. Each instance registers in `.aimux/instances.json` with a heartbeat. Agents from other instances appear inline in the dashboard with a `◈` icon.

- **Enter** on a remote agent takes it over (resumes in your instance)
- `--resume` skips agents already owned by another live instance
- When an instance exits, its agents become offline and visible to other instances
- Dead instances are auto-pruned via PID checks and heartbeat staleness

## Agent Lifecycle

Agents have three states: **running**, **offline**, and **graveyarded**.

```
  running  ──[x]──▶  offline  ──[x]──▶  graveyard
                      │                     │
                      ◀──Enter──            ◀── aimux graveyard resurrect
```

```bash
# List agents in the graveyard
aimux graveyard list

# Stop to offline
aimux stop <sessionId>

# Send directly to graveyard
aimux kill <sessionId>

# Resurrect an agent back to offline state
aimux graveyard resurrect <id>
```

Context files (`.aimux/context/`, `.aimux/history/`) are never deleted — only the agent's state changes.

## Worktrees

aimux manages git worktrees and, by default, creates them inside `.aimux/worktrees/` in the main repo:

```bash
# Spawn a fresh agent
aimux spawn --tool claude

# Fork a live agent into a worktree
aimux fork <sessionId> --tool codex --worktree /abs/path/to/repo/.aimux/worktrees/fix-auth

# Create a worktree
aimux worktree create fix-auth

# List worktrees
aimux worktree list
```

The create location is configurable via `.aimux/config.json` or `~/.aimux/config.json`:

```json
{
  "worktrees": {
    "baseDir": ".aimux/worktrees"
  }
}
```

Relative `baseDir` values are resolved from the main repo root. Absolute paths are also supported.

## Requirements

- macOS (Linux support planned)
- Node.js >= 18
- At least one supported AI tool installed: `claude`, `codex`, or `aider`
- Notifications work out of the box on macOS, Linux, and Windows

## License

MIT
