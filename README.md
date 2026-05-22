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

### Homebrew (macOS / Linux)

```bash
brew tap TraderSamwise/aimux
brew install aimux
```

Brew will pull `node` and `tmux` in as dependencies. The formula auto-updates on every release.

### Standalone installer

Install from GitHub release assets without using npm/yarn as the installer:

```bash
curl -fsSL https://raw.githubusercontent.com/TraderSamwise/aimux/master/scripts/install.sh | sh
```

This installs the bundled release under `~/.aimux/native/` and links `aimux` into `~/.local/bin`.
It still requires Node.js >= 22 and `tmux` in `PATH`; it does not require npm/yarn on the target machine.

To install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/TraderSamwise/aimux/master/scripts/install.sh | AIMUX_VERSION=0.1.13 sh
```

### Build from source

```bash
# Clone and build
git clone https://github.com/TraderSamwise/aimux.git
cd aimux
yarn install
yarn build

# Link globally
yarn link
```

Requires Node.js >= 22 and `tmux` in `PATH`.

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
- project runtime
- advanced global daemon internals
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

The user-facing client (browser + mobile) at `app/` talks to the live control plane directly:

- daemon HTTP is used for project discovery / service discovery
- project-service HTTP is used for live project state and awaited lifecycle actions
- `statusline.json` remains a derived artifact for tmux/status/debugging, not the client's primary transport
- client loading state should clear on heartbeat reconciliation of the expected state change, not on HTTP return alone

Terminal clients are isolated from each other:

- the shared per-project tmux runtime session owns agent windows
- each terminal gets its own tmux client session and dashboard window
- dashboard tab, pointer, and load state are terminal-local
- orchestration, metadata, and plugin sidecars are project-scoped through the daemon-managed project service

Runtime lifecycle:

```bash
aimux                         # open or attach to the current project runtime
aimux dashboard-reload --open # recreate/reopen the dashboard window only
aimux repair                  # repair the current project runtime in place
aimux restart-runtime --open  # hard restart the current project runtime
aimux stop                    # stop the current project runtime
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

Runtime health:

- The tmux statusline shows `ctl ok`, `ctl daemon↓`, or `ctl stale`.
- `ctl stale` means the project-service `statusline.json` snapshot has stopped updating, which usually means the project service died.
- Persistent runtime logging is disabled by default. Enable it with config, env, or CLI flags when reproducing a bug:

```bash
aimux --debug
AIMUX_LOG=1 AIMUX_LOG_LEVEL=debug aimux
AIMUX_LOG=1 AIMUX_LOG_CATEGORIES=daemon,session,tmux aimux
```

- Project logs are written under `~/.aimux/projects/<project-id>/logs/aimux.jsonl`.
- Daemon logs are written under `~/.aimux/daemon/logs/daemon.jsonl`.
- Child stdout/stderr is captured separately as `daemon-stdio.log` or `project-service-stdio.log` when logging is enabled.

```bash
aimux logs path
aimux logs tail -n 100
aimux logs path --daemon
aimux logs tail --daemon
aimux logs clear
```

- Manual recovery is now:

```bash
aimux repair
# or, for a full project-scoped rebuild
aimux restart-runtime --open
```

Daemon rebuild quirk:

- The global daemon and each project service run from the built `dist/` output, not directly from `src/`.
- If you change project-service HTTP behavior, rebuild first with `yarn build`.
- More generally: if you change any `src/*.ts` runtime or CLI behavior, rebuild before testing or asking someone else to test.
- `yarn vitest` / `yarn typecheck` validate source, but they do not update the runtime artifact that `aimux` actually executes.
- If a daemon is already running, restart the project runtime first.
- If a build mismatch persists after `aimux restart-runtime --open`, use the advanced daemon path.

```bash
yarn build
aimux restart-runtime --open

# Advanced fallback if the daemon itself is stale
aimux daemon restart
```

Navigation ownership rule:

- Not all aimux navigation is owned by the main Node runtime.
- Live pane prefix navigation inside tmux-managed agent/service windows is performance-sensitive and may be implemented in tmux control instead of `src/hotkeys.ts` / `src/multiplexer/session-launch.ts`.
- If a new shortcut should behave like existing live-pane `ctrl-a n/p`, use the same tmux control path and target resolution source of truth:
  - [src/tmux/runtime-manager.ts](src/tmux/runtime-manager.ts)
  - [scripts/tmux-control.sh](scripts/tmux-control.sh)
  - [src/tmux/control-script.test.ts](src/tmux/control-script.test.ts)
- Do not clone “similar” ordering logic in the Node runtime for live-pane shortcuts. If the user is pointing at the visible live footer chips and references `n/p`, the shortcut belongs to the tmux layer unless there is a strong reason otherwise.

The browser/mobile client at `app/` exposes these flows directly over daemon (port 43190) and per-project metadata-server HTTP:

- dashboard worktree/agent management
- spawn, fork, rename, migrate, stop, kill
- graveyard browse + resurrect
- worktree create + remove
- activity, workflow, threads, plans, and graveyard secondary screens
- direct message compose, handoff send/accept/complete, and task/review workflow actions
- thread state updates and per-message delivery visibility

For the lifecycle model, see [docs/runtime-lifecycle.md](docs/runtime-lifecycle.md).
For the current source of truth, see [docs/current-architecture.md](docs/current-architecture.md).
For the original Tauri/Svelte client contract (historical, superseded by `app/`), see [docs/desktop-ui-contract.md](docs/desktop-ui-contract.md).
For the migration rationale, see [docs/global-control-plane-rfc.md](docs/global-control-plane-rfc.md).

## Web / Mobile Client (`app/`)

The user-facing browser and native clients live in `app/` as a single Expo Router + React Native project. The same code targets web (browser), iOS, and Android.

For GUI and daemon development, use the isolated `aimux-dev` runtime so your real
`aimux` daemon and active work sessions keep running:

```bash
aimux-dev daemon restart
aimux-dev daemon project-ensure --project /Users/sam/cs/glyde-frontend
cd app
yarn dev:local
```

See [docs/dev-runtime.md](docs/dev-runtime.md) for the full local GUI/backend loop.

```bash
cd app
yarn install
yarn web                  # open browser client (Metro serves it on http://localhost:8081)
yarn ios                  # iOS simulator
yarn android              # Android emulator
```

The app talks to two HTTP surfaces:

- the global aimux daemon at `http://localhost:43190` for project discovery
- per-project metadata servers (port supplied via `/projects` response) for state, agent I/O, plans, and the `/events` SSE stream

For mobile use against a remote machine, set `EXPO_PUBLIC_AIMUX_DAEMON_URL=http://<machine>:43190` in `app/.env`.

Release pipeline (uses EAS):

```bash
cd app
yarn version:bump-build   # new native build
yarn build:testflight     # EAS build → TestFlight
yarn update               # OTA JS-only update (testflight channel)
```

## Tmux Compatibility

Aimux treats tmux as a managed runtime, not a transparent pass-through. For aimux-owned tmux sessions, aimux applies a fixed compatibility contract instead of inheriting whatever ambient tmux defaults happen to exist on the machine.

Managed session policy today:

- `prefix = C-a`
- `prefix2 = C-b`
- `mouse = on` so tmux can own wheel events and enter pane scrollback reliably
- `window-size = latest`
- `aggressive-resize = on` so linked agent windows follow the active terminal client width instead of preserving stale wrap widths from another client
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

- dynamic tmux hotkeys now use a small shell transport that prefers local tmux resolution and falls back to project-service control helpers when needed
- the final window switch still happens in tmux
- this avoids spawning the heavyweight operator CLI for normal `n/p/s/u/d` navigation
- dashboard client sessions are kept alive for reuse; exiting a managed dashboard leaves the client instead of destroying the reusable dashboard window
- stale dashboard artifacts are pruned automatically before open/reload so broken `cat`/`tail` dashboard panes do not poison future attaches
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
- `GET /agents/teammates?parentSessionId=...`
- `POST /agents/teammates/create`
- `POST /agents/teammates/tasks`
- `POST /agents/teammates/stop`
- `POST /agents/teammates/resume`
- `POST /agents/teammates/kill`
- `POST /agents/teammates/resurrect`

Use `aimux metadata endpoint` to get the local base URL for the current project service.

Teammate agents are first-party aimux agents attached to a parent agent. They stay hidden from the normal dashboard unless the parent agent is focused, but can still be inspected, entered, stopped, restarted, and graveyarded through the parent/team UI.

Dashboard navigation exposes only the selected parent's direct team:

- On the dashboard, select a parent agent and press `e` to open its teammate picker.
- In an attached agent pane, press `Ctrl-A e` to toggle between the parent and its first/active teammate.
- `Ctrl-A n/p` stays within the current plane: root agent/service panes before `Ctrl-A e`, direct teammates after `Ctrl-A e`.
- Non-selected parents do not expose their teammates in dashboard rows, details, or footer chips.

Direct teammate teams are capped at 3 agents. Creating a teammate is idempotent by normalized `role` + `label` for the same parent: if that direct teammate already exists, aimux returns it instead of creating a duplicate.

List direct teammates for a parent:

```bash
endpoint="$(aimux metadata endpoint)"
curl -sS "$endpoint/agents/teammates?parentSessionId=claude-abc123"
```

Create a teammate from an agent or shell with:

```bash
endpoint="$(aimux metadata endpoint)"
curl -sS "$endpoint/agents/teammates/create" \
  -H 'content-type: application/json' \
  -d '{
    "parentSessionId": "claude-abc123",
    "role": "coder",
    "label": "coder-1",
    "initialTask": {
      "title": "Parser tests",
      "body": "Implement the bounded parser tests and report back."
    }
  }'
```

Useful request fields:

- `parentSessionId` - required aimux session ID of the primary agent.
- `role` / `label` - optional teammate role and display label.
- `tool` - optional tool config key; omitted means inherit the parent tool and safe model/provider/runtime flags.
- `sessionId` - optional aimux session ID; omitted means aimux generates one.
- `worktreePath` - optional target worktree; omitted means inherit the parent worktree.
- `extraArgs` - optional CLI args for model/provider flags; when set, these override inherited runtime flags.
- `initialTask` - optional first durable task assigned to the teammate after launch.
- `order` - optional numeric order within the parent's direct team.
- `open` - optional boolean; `false` creates without switching focus.

Delegate to an existing direct teammate:

```bash
curl -sS "$endpoint/agents/teammates/tasks" \
  -H 'content-type: application/json' \
  -d '{
    "parentSessionId": "claude-abc123",
    "teammateSessionId": "codex-def456",
    "title": "Review parser patch",
    "body": "Review the parser patch and report blockers first."
  }'
```

`/agents/teammates/tasks` only accepts direct teammates of the parent and creates a normal durable task targeted to that teammate. The teammate reports back with `aimux task complete` or `aimux task block`, and aimux routes completion back to the parent.

Manage a direct teammate lifecycle with the same parent/teammate guard:

```bash
curl -sS "$endpoint/agents/teammates/stop" \
  -H 'content-type: application/json' \
  -d '{ "parentSessionId": "claude-abc123", "teammateSessionId": "codex-def456" }'
```

Use `/agents/teammates/resume` for offline teammates, `/agents/teammates/kill` to send a direct teammate to the graveyard, and `/agents/teammates/resurrect` to move a direct graveyarded teammate back to offline. Each endpoint rejects teammates not directly attached to the parent.

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
  - supports exact backend-session-id resume when aimux starts it with `--session-id {id}` and restores it with `--resume {id}`
  - targeted dashboard restore must use that exact id or fail loudly; it must not fall back to `--continue`
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
  "logging": {
    "enabled": false,
    "level": "info",
    "categories": ["*"],
    "maxBytes": 10000000,
    "maxFiles": 5
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

Logging:

- `enabled` — persist structured JSONL runtime logs
- `level` — `error`, `warn`, `info`, `debug`, or `trace`
- `categories` — category allowlist, or `["*"]`
- `maxBytes` / `maxFiles` — simple file rotation limits
- CLI overrides: `--debug`, `--trace`, `--log-level <level>`, `--log-category <a,b>`
- Env overrides: `AIMUX_LOG`, `AIMUX_LOG_LEVEL`, `AIMUX_LOG_CATEGORIES`

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
| `resumeByBackendSessionId` | Whether aimux's stored backend id is safe to pass to `resumeArgs` |
| `resumeFallback` | Non-specific fallback resume args for explicit latest-session flows; targeted dashboard restore must not use these |
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
- Node.js >= 22
- At least one supported AI tool installed: `claude`, `codex`, or `aider`
- Notifications work out of the box on macOS, Linux, and Windows

## Releasing

Releases publish to npm, GitHub Releases, and the Homebrew tap from a single tag push.

```bash
yarn release:patch   # 0.1.13 → 0.1.14
yarn release:minor   # 0.1.13 → 0.2.0
yarn release:major   # 0.1.13 → 1.0.0
```

Each script bumps `package.json`, creates a `vX.Y.Z` commit + tag, and pushes both. The `release` workflow then builds four platform tarballs, uploads them to a GitHub release, publishes the npm package, and bumps the Homebrew formula.

## License

MIT
