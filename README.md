# aimux

Native CLI agent multiplexer with an API-first control plane — run multiple AI coding tools side-by-side with their native TUIs intact, then control them from the terminal dashboard, web app, mobile app, CLI, or scripts through the same daemon/project-service APIs.

aimux uses `tmux` as its local execution substrate. Each project gets one managed tmux runtime session, each agent runs in its own tmux window, and each terminal gets its own dashboard client window. Shared project state lives behind the project service, so the terminal TUI is a client of the same HTTP/SSE control plane used by the web and mobile app.

## Features

- **tmux-backed execution** — real PTYs, scrollback, attach/detach, repaint, and terminal compatibility come from tmux instead of a custom multiplexer
- **API-first control plane** — the daemon and per-project service expose typed HTTP/SSE APIs used by the terminal TUI, Expo web/mobile app, CLI helpers, and scripts
- **Single-writer project service** — notifications, threads, tasks, handoffs, reviews, Coordination, project views, and lifecycle mutations are owned by the project service
- **Thin dashboard clients** — each terminal gets its own dashboard tmux client session/window while shared project state stays service-backed
- **Agent windows** — each agent gets its own tmux window with its native TUI intact
- **tmux status integration** — the native tmux status line shows aimux session, task, headline, and metadata state from service-written snapshots
- **Metadata and plugin APIs** — scripts, agents, and local watchers can publish status, progress, logs, and notifications through the project service
- **Plugin/watcher seam** — local plugins can watch files or external tools and publish metadata without patching aimux core
- **Leader key switching in dashboard** — `Ctrl+A` prefix for dashboard actions like create/kill/switch while you are in the aimux dashboard window
- **Dashboard view** — see all running, offline, and remote agents at a glance
- **Multi-instance** — run aimux in multiple terminal tabs; agents from other instances appear inline and can be taken over
- **Agent lifecycle** — two-step kill (`[x]` stops → offline, `[x]` again → graveyard), with `aimux graveyard resurrect` for recovery
- **Coordination inbox** — the project service builds one "needs-you" worklist from notifications, threads, tasks, handoffs, reviews, and live agent reachability
- **Threaded orchestration** — direct messages, handoffs, task assignment, and review flows go through durable runtime-exchange state and explicit user/agent workflow actions
- **Dashboard orchestration actions** — from the main dashboard, use `S` to send a message, `H` to send a handoff, `T` to assign a task, `o` to jump to the most relevant thread, and `R` to reply when something is waiting on you
- **Workflow actions everywhere** — TUI and web/mobile clients use the same API routes for accept/block/complete/reopen/reply/review actions
- **Next-action guidance** — dashboard rows and details surface `on me`, `blocked`, family-chain pressure, and the single most relevant next orchestration step
- **Context sharing** — agents can read each other's conversation history via `.aimux/context/`
- **Session resume** — resume previous sessions using each tool's native resume (`--resume`) or injected history (`--restore`)
- **Git worktree support** — first-class worktree management for parallel feature work, with per-worktree agent isolation
- **Fully config-driven** — all tool behavior (prompt detection, session capture, resume, compaction) is declarative config, not code
- **Configurable** — global (`~/.aimux/config.json`) and project-level (`.aimux/config.json`) configuration with deep merge
- **Notifications** — cross-platform notifications (macOS, Linux, Windows) when agents need attention or complete tasks
- **Project event stream** — each project service exposes an SSE stream for project updates, alerts, and remote-client refreshes
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
It still requires Node.js >= 24 and `tmux` in `PATH`; it does not require npm/yarn on the target machine.
When replacing an existing install, the installer automatically runs the safe `aimux restart`
repair: daemon restart, project-service re-ensure, and dashboard reloads. It does not kill agent
tmux windows. If a release ever requires a destructive tmux runtime rebuild, affected dashboards
show a blocking rebuild warning instead.

To install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/TraderSamwise/aimux/master/scripts/install.sh | AIMUX_VERSION=0.1.13 sh
```

To install a frozen local build from the current checkout:

```bash
AIMUX_RELEASE_VERSION=local-$(git rev-parse --short HEAD) yarn release:asset
ASSET="$(ls -t release/aimux-*.tar.gz | head -n 1)"
scripts/install.sh "$ASSET"
```

That keeps `aimux` as a stable installed artifact under `~/.aimux/native/` instead of a live symlink to the repository. The installer updates `~/.local/bin/aimux` to point at the installed bundle.

For development, remember the distinction:

- `yarn build` updates this checkout's `dist/`, so `node dist/main.js ...` sees source changes.
- Plain `aimux ...` runs the installed bundle behind `~/.local/bin/aimux`, so it will not see source changes until you build and install a local release archive.
- Reinstalling a local release archive automatically runs the safe `aimux restart` repair. Set `AIMUX_SKIP_POST_INSTALL_RESTART=1` only when testing the installer itself.

### Build from source

```bash
# Clone and build
git clone https://github.com/TraderSamwise/aimux.git
cd aimux
yarn install
yarn build

# Install this checkout as the plain `aimux` command
AIMUX_RELEASE_VERSION=local-$(git rev-parse --short HEAD) yarn release:asset
ASSET="$(ls -t release/aimux-*.tar.gz | head -n 1)"
scripts/install.sh "$ASSET"
aimux doctor versions
```

Requires Node.js >= 24 and `tmux` in `PATH`.

### Develop the App from Source

The browser/mobile client lives in `app/` and talks to the local aimux daemon.

```bash
yarn install
cp app/.env.example app/.env
cd app
yarn dev:web:local      # web client on http://localhost:8081
yarn dev:native:local   # Metro for an installed native dev build
yarn dev:ios:local      # build/install/open iOS simulator dev build
yarn dev:android:local  # build/install/open Android emulator dev build
```

Use the installed `aimux` command for local development too. Backend changes must be built into a local release asset, installed with `scripts/install.sh`, and activated with `aimux restart`; do not point `~/.local/bin/aimux` directly at this checkout.

For an already-installed native dev build:

```bash
aimux daemon ensure
cd app
yarn dev:native:local
```

Only one Expo/Metro process can own port `8081`. If the simulator loads another
app's JavaScript bundle, stop that other Expo process and restart Aimux Metro.

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

Aimux separates local execution from the shared control plane.

Runtime layers:

1. **Global daemon** — one local host service for project discovery, project activation, and supervision of project services. `aimux` uses port `43190` by default; explicit environment overrides can target another port for rare sandboxing.
2. **Per-project service** — the project-local HTTP/SSE authority, implemented by the metadata server. It is the single writer for shared project control-plane state.
3. **tmux runtime** — the managed per-project tmux session that owns agent/service/dashboard windows, PTYs, scrollback, attach/detach, and same-machine focus/open behavior.
4. **Clients** — the terminal TUI dashboard, Expo web/mobile app, CLI commands, scripts, and plugins. Clients read and mutate shared project state through daemon/project-service APIs.

The project service owns:

- live project state and API lifecycle
- notifications, threads, tasks, handoffs, reviews, and Coordination worklists
- lifecycle mutations such as spawn, stop, kill, fork, worktree, graveyard, and workflow actions
- `/events` SSE project updates and alerts for TUI, web, and mobile clients
- plugin runtime and project-scoped metadata sidecars
- derived `statusline.json` snapshots for tmux status/debugging

The terminal dashboard is API-backed for shared workflows. It still owns terminal-local UI state such as current screen, selection, filters, text buffers, overlays, and render timing. It also participates in same-machine tmux behavior, because focusing a local tmux window is inherently different from a remote web/mobile deep link or pane stream.

There is no per-project host election. Dashboard windows are clients, not control-plane owners.

Client/write boundary:

- TUI shared reads use project-service APIs such as `/desktop-state`, `/coordination-worklist`, topology, project, library, graveyard, and worktree routes.
- TUI shared mutations use project-service APIs for notifications, threads, tasks, handoffs, reviews, agent lifecycle, services, worktrees, and graveyard actions.
- CLI lifecycle and workflow writes also require the project service; read-only CLI inspection and hook safety fallbacks are the narrow exceptions.
- The project service still computes local runtime models in-process because it is the API authority for those routes.

The user-facing app at `app/` talks to the same live control plane:

- daemon HTTP is used for project discovery and service discovery
- project-service HTTP is used for live project state and awaited lifecycle/workflow actions
- project-service `/events` SSE is used for heartbeat reconciliation, alerts, and refreshes
- `statusline.json` is a derived artifact for tmux/status/debugging, not a client transport
- client loading state should clear on heartbeat reconciliation of the expected state change, not on HTTP return alone

Terminal clients are isolated from each other:

- the shared per-project tmux runtime session owns agent windows
- each terminal gets its own tmux client session and dashboard window
- dashboard tab, pointer, filter, and load state are terminal-local
- orchestration, metadata, notifications, and workflow state are project-scoped through the daemon-managed project service

Cross-project terminal surfaces follow the same split:

- semantic product state belongs to daemon/project-service APIs
- tmux owns terminal mechanics: pane capture, window focus, client switching, window linking, and same-machine open behavior
- tmux metadata is a bridge for identity only: project root, worktree path, session id, window id, tool, label, and lightweight status hints
- Exposé and the meta dashboard may use local tmux metadata for live previews and jumps, but they must not become a second writer or second source of truth for notifications, threads, workflow state, health, or lifecycle
- web/mobile parity for terminal actions requires pane streaming or deep links; it does not mean remote clients should learn raw tmux switching

Runtime lifecycle:

```bash
aimux                         # open or attach to the current project runtime
aimux restart                 # restart daemon/services and reload all known dashboards
aimux doctor versions         # inspect daemon/service/dashboard build coherence
aimux repair                  # repair the current project runtime in place
aimux dashboard-reload --open # advanced: recreate/reopen one dashboard window only
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

# Focus a live agent in a same-machine tmux client
terminal focus uses the thin tmux fast-control entrypoint via the project service and terminal client tty
```

HTTP-backed agent output helpers:

```bash
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

These commands are additive control-plane helpers on top of the existing `aimux -> tmux -> codex/claude` runtime. They do not replace the native TUI path; they reuse the tmux pane capture path through the project HTTP service.

For GUI, remote, and script callers, prefer explicit `--project` usage instead of relying on launcher cwd.

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
aimux restart
aimux doctor versions
```

- Project-scoped repair remains available when the tmux topology, statusline, or a single project runtime needs attention:

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
- If a daemon or project dashboard is already running, run the coherent restart after rebuilding.
- `aimux restart` restarts the daemon, re-ensures known project services, and reloads existing dashboard windows without killing agent tmux windows.
- `aimux restart-runtime --open` is the destructive project-scoped reset; use it when the managed tmux runtime itself must be rebuilt.

```bash
yarn build
aimux restart
aimux doctor versions
```

Navigation ownership rule:

- Not all aimux navigation is owned by the main Node runtime.
- Live pane prefix navigation inside tmux-managed agent/service windows is performance-sensitive and may be implemented in tmux control instead of `src/hotkeys.ts` / `src/multiplexer/session-launch.ts`.
- If a new shortcut should behave like existing live-pane `ctrl-a n/p`, use the same tmux control path and target resolution source of truth:
  - [src/tmux/runtime-manager.ts](src/tmux/runtime-manager.ts)
  - [scripts/tmux-control.sh](scripts/tmux-control.sh)
  - [src/tmux/control-script.test.ts](src/tmux/control-script.test.ts)
- Do not clone “similar” ordering logic in the Node runtime for live-pane shortcuts. If the user is pointing at the visible live footer chips and references `n/p`, the shortcut belongs to the tmux layer unless there is a strong reason otherwise.

The browser/mobile client at `app/` exposes these flows over daemon (port 43190 by default) and per-project metadata-server HTTP:

- project discovery, dashboard monitoring, topology, and session views
- agent lifecycle: spawn, stop, kill, fork, rename, migrate, graveyard, and resurrect
- worktree create/list/remove helpers
- pane read and live pane streaming for remote terminal views
- notifications, Coordination worklist, threads, tasks, handoffs, reviews, and workflow actions
- project `/events` SSE updates for heartbeat, alerts, and refreshes

For the lifecycle model, see [docs/runtime-lifecycle.md](docs/runtime-lifecycle.md).
For the current source of truth, see [docs/current-architecture.md](docs/current-architecture.md).
For the original Tauri/Svelte client contract (historical, superseded by `app/`), see [docs/desktop-ui-contract.md](docs/desktop-ui-contract.md).
For the migration rationale, see [docs/global-control-plane-rfc.md](docs/global-control-plane-rfc.md).

## Web / Mobile Client (`app/`)

The user-facing browser and native clients live in `app/` as a single Expo Router + React Native project. The same code targets web (browser), iOS, and Android.

For GUI and daemon development, use the installed `aimux` runtime. Backend changes
need a local release install before the daemon or project services can run them:

```bash
AIMUX_RELEASE_VERSION=local-$(git rev-parse --short HEAD) yarn release:asset
ASSET="$(ls -t release/aimux-*.tar.gz | head -n 1)"
scripts/install.sh "$ASSET"
cd app
yarn dev:web:local
```

See [docs/dev-runtime.md](docs/dev-runtime.md) for the full local GUI/backend loop.

```bash
cd app
yarn install
yarn dev:web:local        # browser client on http://localhost:8081
yarn dev:native:local     # Metro for an installed native dev build
yarn dev:ios:local        # build/install/open iOS simulator dev build, not Expo Go
yarn dev:android:local    # build/install/open Android emulator dev build
```

The app talks to two HTTP surfaces:

- the global aimux daemon at `http://localhost:43190` for project discovery
- per-project metadata servers (port supplied via `/projects` response) for state, agent I/O, plans, and the `/events` SSE stream

For a built local web UI without Cloudflare relay or hosted auth, run:

```bash
aimux ui --open
```

`aimux ui` serves the exported first-party web app from the local machine, ensures
the loopback daemon is running, and injects local runtime config for the daemon
port. The UI server binds to `127.0.0.1:43192` by default; use `--port` to choose
a different local UI port.

For simulator-local development, the helper scripts use `http://127.0.0.1:43190`
for iOS and `http://10.0.2.2:43190` for Android. For mobile use against a remote
machine, set `EXPO_PUBLIC_AIMUX_DAEMON_URL=http://<machine>:43190` in `app/.env`.

Release pipeline (uses the shared `@tradersamwise/eas-release` CLI). Two paths,
chosen by what changed — always bump the version first, then ship:

```bash
cd app
# OTA update — JavaScript / asset changes only
yarn version:bump-ota && yarn update              # testflight
yarn version:bump-ota && yarn update:production   # production

# Native build — native deps, Expo plugins, permissions, icons, splash, native config
yarn version:bump-build && yarn build:testflight   # testflight
yarn version:bump-build && yarn build:production    # production
```

OTA covers JS and assets; a native rebuild is required for anything that changes
the native binary or its Expo runtime fingerprint. `bump-ota` aborts if the runtime
changed since the last native build (an OTA can only target the installed runtime).

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
| `Ctrl+A g` | Exposé: tile live previews of agents; press `1`-`9` to jump, `g` to zoom out |
| `Ctrl+A m` | Meta dashboard: cross-project tmux dashboard for running projects |
| `Ctrl+A Ctrl+A` | Send literal Ctrl+A inside the dashboard |

When you are inside an agent window, tmux owns the terminal. Use normal tmux window navigation or run `aimux` again to return to the dashboard window. `Ctrl+A g` (Exposé) also works inside an agent window, where it scopes to that agent's worktree by default; set `expose.initialScope` to `worktree`, `project`, or `global` to choose the starting scope. With Exposé open, pressing `g` zooms the scope out one level — worktree → project (all worktrees) → all projects — so you can widen the view without leaving the overlay; the zoom is per-session and resets next time you open it.

The meta dashboard is a local tmux window named `meta-dashboard`. It lists registered projects for the current `AIMUX_HOME`, groups running projects by worktree, refreshes from local tmux state, and jumps by switching the real terminal client into the target project's per-client session. Opening Exposé from the meta dashboard starts in `global` scope, showing live tiles across all running projects.

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

## Project Service API

The daemon-managed project service is the shared API surface for a project. The terminal dashboard, web/mobile app, CLI helpers, scripts, and plugins use it instead of writing shared project state directly.

Core routes include:

- health and state: `GET /health`, `GET /desktop-state`, `GET /coordination-worklist`, `GET /events`
- notifications: list, mark read, clear, and alert routes
- threads and workflow actions: mark seen, open, reply, update status, handoff/task/review actions
- lifecycle and topology: spawn, stop, kill, fork, rename, migrate, worktrees, graveyard, pane read, pane stream
- metadata: status, progress, logs, and plugin/watch sidecar updates

The metadata API is still available as the low-level status/progress/log surface. The tmux status line reads service-written metadata snapshots and shows them for the active session.

CLI helpers:

```bash
aimux metadata endpoint
aimux metadata set-status <session> "Deploying" --tone warn
aimux metadata set-progress <session> 3 10 --label services
aimux metadata log <session> "Tests passed" --source ci --tone success
aimux metadata clear-log <session>
```

The metadata subset of the project-service HTTP API exposes:

- `GET /health`
- `GET /state`
- `POST /set-status`
- `POST /set-progress`
- `POST /log`
- `POST /clear-log`
- `POST /notify`

Use `aimux metadata endpoint` to get the local base URL for the current project service.

Teammate agents are first-party aimux agents attached to a parent agent. They stay hidden from the normal dashboard unless the parent agent is focused, but can still be inspected, entered, stopped, restarted, and graveyarded through the parent/team UI. Programmatic teammate lifecycle routes are control-plane internals; agents should use explicit aimux task, handoff, or thread commands only when the user asks for delegation or handoff.

Dashboard navigation exposes only the selected parent's direct team:

- On the dashboard, select a parent agent and press `e` to open its teammate picker.
- In an attached agent pane, press `Ctrl-A e` to toggle between the parent and its first/active teammate.
- `Ctrl-A n/p` stays within the current plane: root agent/service panes before `Ctrl-A e`, direct teammates after `Ctrl-A e`.
- Non-selected parents do not expose their teammates in dashboard rows, details, or footer chips.

Direct teammate teams are capped at 3 agents. Creating a teammate is idempotent by normalized `role` + `label` for the same parent: if that direct teammate already exists, aimux returns it instead of creating a duplicate.

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

Agents are told about these files in their startup preamble.

These are the canonical agent-facing paths. Runtime-private state stays under `~/.aimux/projects/<project-id>/...` and is not part of the agent contract.

In tmux mode, live terminal state comes from tmux itself. Runtime topology is stored in `~/.aimux/projects/<project-id>/runtime-topology.yaml`; `~/.aimux/projects/<project-id>/state.json` is service/project state and is not the agent session source of truth.

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
  - uses `developer_instructions` for clean startup and fork/migration continuity, with seeded files as durable carried-over context

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

Agents coordinate through aimux task, handoff, review, and thread commands backed by the runtime exchange and exposed through the project service API. They should not invent a separate delegation file format or spawn other agents directly unless the user gives an explicit CLI/API instruction.

Common flows:

```bash
aimux message send "Need UI review on the login flow" --assignee ui
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
```

The project service builds Coordination from the durable runtime-exchange records plus live agent reachability and notification state. TUI, web, mobile, CLI, and scripts all see the same worklist and use the same workflow action routes.

Ask your agent to delegate or hand off when you want a coordination record created. For example:

> "Delegate the test writing to another agent"
> "Hand off the CSS cleanup to the codex agent"

Control-plane callers may expose teammate workflow APIs where configured, but agents should not call aimux metadata APIs themselves. This is separate from any native task system in the underlying tools, such as Claude Code's internal tasks.

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
      "promptPatterns": ["^> $", "^\\$ $"],
      "turnPatterns": ["^[>❯]\\s*(.+)"],
      "compactCommand": "claude --print --output-format text",
      "developerInstructionsConfigKey": "developer_instructions"
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
| `promptPatterns` | Regex patterns for idle/prompt detection in status bar |
| `turnPatterns` | Regex patterns for extracting conversation turns from output |
| `compactCommand` | Shell command for LLM-powered history compaction |
| `instructionsFile` | Optional opt-in file to merge aimux's managed standing instructions into; disabled by default so aimux does not create `AGENTS.md` |
| `developerInstructionsConfigKey` | Codex config key for model-visible standing instructions, normally `developer_instructions`; set to `null` only when you do not want aimux to inject Codex startup instructions |

Codex startup instructions use `-c developer_instructions=...` when configured. Aimux does not create `AGENTS.md` by default; existing user-authored `AGENTS.md` files are still read by Codex itself. Verify the installed Codex CLI exposes the developer-instructions channel with:

```bash
yarn verify:codex-instructions
```

## Multi-Client Runtime

Run aimux in multiple terminal tabs or through the dashboard for the same project. Session lifecycle, ownership, graveyard state, and exact resume identity live in runtime topology.

- `.aimux/instances.json` is legacy and is not an active liveness or ownership source.
- Remote/share presence belongs to relay/share transport state unless explicitly mirrored from topology.
- `--resume` does not use instance-registry session refs for ownership decisions.
- When a runtime exits, topology-backed offline rows keep agents visible to other clients.
- `aimux` has one normal runtime lane under `~/.aimux` on daemon port `43190`.
  Use explicit `AIMUX_HOME` and `AIMUX_DAEMON_PORT` overrides only for rare
  sandboxing, and do not create a second named CLI lane.
- A visible offline agent row must come from topology. If the row has an exact
  backend session id, restore is marked ready. If that id is missing for a tool
  that requires exact backend resume, the row remains visible but restore is
  blocked with a reason instead of guessing a fallback session.

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
- Node.js >= 24
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
