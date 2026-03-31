# aimux

Native CLI agent multiplexer — run multiple AI coding tools side-by-side with their native TUIs intact.

aimux uses `tmux` as its terminal runtime substrate. Each project gets its own managed tmux session, the aimux dashboard lives in window `0`, and each agent runs in its own tmux window while aimux keeps orchestration, worktrees, plans, and metadata on top.

## Features

- **tmux-backed runtime** — real scrollback, attach/detach, repaint, and terminal compatibility come from tmux instead of a custom multiplexer
- **Dashboard window** — aimux dashboard lives in tmux window `0` for the current project session
- **Agent windows** — each agent gets its own tmux window with its native TUI intact
- **tmux status integration** — the native tmux status line shows aimux session, task, headline, and metadata state
- **Metadata API** — scripts and agents can push status, progress, logs, and notifications into the tmux status line
- **Plugin/watcher seam** — local plugins can watch files or external tools and publish metadata without patching aimux core
- **Leader key switching in dashboard** — `Ctrl+A` prefix for dashboard actions like create/kill/switch while you are in the aimux dashboard window
- **Dashboard view** — see all running, offline, and remote agents at a glance
- **Multi-instance** — run aimux in multiple terminal tabs; agents from other instances appear inline and can be taken over
- **Agent lifecycle** — two-step kill (`[x]` stops → offline, `[x]` again → graveyard), with `aimux graveyard resurrect` for recovery
- **Task delegation** — agents can delegate work to each other via `.aimux/tasks/`, with automatic dispatch, completion notifications, and dashboard badges
- **Context sharing** — agents can read each other's conversation history via `.aimux/context/`
- **Session resume** — resume previous sessions using each tool's native resume (`--resume`) or injected history (`--restore`)
- **Git worktree support** — first-class worktree management for parallel feature work, with per-worktree agent isolation
- **Fully config-driven** — all tool behavior (prompt detection, session capture, resume, compaction) is declarative config, not code
- **Configurable** — global (`~/.aimux/config.json`) and project-level (`.aimux/config.json`) configuration with deep merge
- **Notifications** — cross-platform notifications (macOS, Linux, Windows) when agents need attention or complete tasks
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
# Launch dashboard (attaches/switches to the per-project tmux session, window 0)
aimux

# Launch a specific tool in a new tmux agent window
aimux claude
aimux codex
aimux aider

# Resume all offline sessions
aimux --resume
```

The per-project tmux session is the long-lived substrate. `aimux server` no longer exists in the normal runtime model.

## Tmux Compatibility

Aimux treats tmux as a managed runtime, not a transparent pass-through. For aimux-owned tmux sessions, aimux applies a fixed compatibility contract instead of inheriting whatever ambient tmux defaults happen to exist on the machine.

Managed session policy today:

- `prefix = C-a`
- `prefix2 = C-b`
- `mouse = off` so the outer terminal can own command-click and text selection
- `extended-keys = always`
- `extended-keys-format = csi-u`
- `terminal-features` includes `xterm*:extkeys`
- `terminal-features` includes `xterm*:hyperlinks`
- managed Claude/Codex windows get `allow-passthrough = on`
- managed Claude/Codex windows get scoped modified-enter bindings for multiline input compatibility

This is why aimux can support features like `Ctrl+J`, `Shift+Enter`, and command-clicked links inside managed tmux sessions without depending on user-specific tmux configuration.

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

Recommended tmux mental model:

- window `0` is the aimux dashboard
- each agent is its own tmux window
- aimux metadata, plans, worktrees, and task orchestration sit on top of that session

For normal tmux users outside aimux, the equivalent setup usually lives in `~/.tmux.conf`. Aimux just codifies that policy inside its own managed sessions so behavior is stable across projects and terminals.

## Tmux Status Line

Aimux now uses tmux's native status bar instead of an in-terminal custom footer.

The managed tmux session config renders:

- **left**: aimux project identity
- **middle**: native tmux window list
- **right**: aimux session/task/headline/flash metadata

This keeps the terminal surface fully tmux-native while still surfacing the old footer's useful information.

Status rendering has two practical data paths that must stay visually aligned:

- the rich path from `statusline.json` written by the dashboard process
- the fallback path from live tmux window metadata

When extending the footer/status UI, treat both as first-class render sources. The fallback path must carry enough metadata to render the same identity, role, and activity state as the richer dashboard-written path, otherwise the status bar will visibly flicker between styles during updates.

For future tool wiring and continuity expectations, see [docs/tool-integration.md](docs/tool-integration.md).

## Metadata API

Inspired by opensessions, aimux exposes a small project-local metadata API from the dashboard process. The tmux status line reads this state and shows it for the active session.

CLI helpers:

```bash
aimux metadata endpoint
aimux metadata set-status <session> "Deploying" --tone warn
aimux metadata set-progress <session> 3 10 --label services
aimux metadata log <session> "Tests passed" --source ci --tone success
aimux metadata clear-log <session>
```

The dashboard-hosted HTTP API also exposes:

- `GET /health`
- `GET /state`
- `POST /set-status`
- `POST /set-progress`
- `POST /log`
- `POST /clear-log`
- `POST /notify`

Use `aimux metadata endpoint` to get the local base URL for the current project.

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

# Resurrect an agent back to offline state
aimux graveyard resurrect <id>
```

Context files (`.aimux/context/`, `.aimux/history/`) are never deleted — only the agent's state changes.

## Worktrees

aimux manages git worktrees and, by default, creates them inside `.aimux/worktrees/` in the main repo:

```bash
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
