# Aimux Agent Instructions

## Instruction Files

- `AGENTS.md` is the canonical shared instruction file for this repository.
- `CLAUDE.md` is a Claude Code adapter and should import `AGENTS.md` with `@AGENTS.md`.
- Do not symlink `CLAUDE.md` to `AGENTS.md`; keep the adapter explicit so it works across tools and platforms.
- Add nested `AGENTS.md` files only when a subtree needs different rules.
- Add nested `CLAUDE.md` files only when Claude needs subtree-specific memory; prefer importing the matching `AGENTS.md` from them.
- Keep durable project conventions here, not only in a single agent's private memory.

## Product Context

Aimux is an agent multiplexer. It runs long-lived Claude, Codex, and shell sessions in tmux windows scoped to a project checkout or one of that project's git worktrees. The dashboard is the user-facing control plane for creating, entering, stopping, reviving, and coordinating those sessions.

Agents inside aimux coordinate through aimux task, handoff, and thread commands backed by the runtime exchange, not by directly spawning each other unless the user gives an explicit CLI command. Use explicit aimux CLI/API task or handoff operations only when the user explicitly asks for delegation or handoff. Do not proactively write `.aimux/plans/*` or `.aimux/status/*` for simple questions, read-only inspections, or one-shot tasks.

## Runtime Architecture

Aimux separates local execution from the shared control plane.

- The global daemon owns project discovery, project activation, and supervision of per-project services.
- The per-project service (`src/metadata-server.ts`) is the single writer/authority for shared project control-plane state.
- The managed tmux runtime owns local execution: agent/service/dashboard windows, PTYs, scrollback, attach/detach, and same-machine focus/open behavior.
- Clients include the terminal TUI dashboard, Expo web/mobile app, CLI helpers, scripts, and plugins. They should use daemon/project-service APIs for shared reads and mutations.

Shared control-plane state includes notifications, threads, tasks, handoffs, reviews, Coordination, project/topology/library views, graveyard/worktree state, and lifecycle mutations. TUI-local state is limited to presentation concerns such as selection, filters, current screen, overlays, text buffers, and terminal render timing.

When changing dashboard behavior, preserve the API-backed boundary:

- Use `src/multiplexer/dashboard-control.ts` request helpers for TUI reads/mutations that affect shared project state.
- Keep shared response contracts aligned with `src/project-api-contract.ts` and app wrappers in `app/lib/api.ts`.
- Do not add direct dashboard writes to runtime-exchange, notification stores, thread/task/review state, topology, or worktree/graveyard state.
- `statusline.json` is a derived/debug/status artifact, not the primary transport for TUI or app state.

Remote-only is not the goal. Execution and service composition remain local by design; web/mobile parity comes from API-backed control-plane routes plus remote equivalents for tmux-specific behavior such as pane streaming or deep-link/focus actions.

## Stable vs Dev CLI

- `aimux` should be a frozen, versioned local or release install under `~/.aimux/native/`. It is for real project work and production remote auth, so defaults should point at `https://aimux.app` and the production relay unless explicitly overridden.
- `aimux-dev` should stay repo-linked for Aimux development. It sets `AIMUX_HOME=~/.aimux-dev`, `AIMUX_DAEMON_PORT=43191`, `AIMUX_ENV=development`, and `AIMUX_WEB_APP_URL=http://localhost:8081`.
- Do not point `~/.local/bin/aimux` directly at this checkout for normal development. Use `aimux-dev` for live source iteration and rebuild with `yarn build` after `src/*.ts` changes.
- To create a local stable build from current source, build a release asset with `AIMUX_RELEASE_VERSION=<version-or-local-label> yarn release:asset`, then install it with `scripts/install.sh release/aimux-<platform>-<arch>.tar.gz`.

## App (`app/`) - Expo Router + RN + Web

The browser and native clients live in `app/`. Single Expo codebase targeting web, iOS, and Android.

### Development With HMR

```bash
cd app
yarn dev:web:local      # web client on http://localhost:8081, HMR, aimux-dev daemon
yarn dev:native:local   # Metro for an already-installed native dev build
yarn dev:ios:local      # build/install/open the iOS simulator dev build, not Expo Go
yarn dev:android:local  # build/install/open the Android emulator dev build
```

What triggers what:

- `app/app/`, `app/components/`, `app/lib/`, `app/stores/` changes: Metro HMR, no restart.
- `src/*.ts` Node CLI changes: run `yarn build` at the repo root so the daemon and metadata server see updated `dist/` code.
- The app is a pure HTTP+SSE client of the aimux daemon; it does not bundle the CLI.

### App Architecture

- `app/app/`: Expo Router screens. `(main)` is the authenticated app shell with project sidebar plus chat, plans, threads, graveyard, and settings screens.
- `app/lib/api.ts`: typed HTTP client. Daemon routes target `localhost:43190` by default; per-project metadata-server routes target the `serviceEndpoint` returned by `/projects`.
- `app/lib/heartbeat.ts`: `event-source-polyfill` wrapper for the per-project `/events` SSE stream. The polyfill auto-reconnects on transient failures.
- `app/stores/`: Jotai stores.
- `app/lib/image-picker.{web,native}.ts`: platform split. Web uses `<input type=file>`; native uses `expo-image-picker`.

### App State

- Use Jotai for client state.
- Durable app preferences belong in `app/stores/settings.ts`.
- Follow the donor `~/cs/jiten/stores/settings.ts` pattern:
  - one persisted `settingsAtom`
  - `atomWithStorage`
  - merging defaults for newly added fields
  - focused atoms via `jotai-optics`
- Do not add durable preferences as local React state.
- Keep transient UI-only state in `app/stores/ui.ts`.
- Keep per-session chat/output state in `app/stores/chat.ts`.
- Keep project selection and daemon project snapshots in `app/stores/projects.ts`.

### What The App Is Not

- Not a daemon owner. The app is a client; it cannot start, restart, or repair the daemon. The daemon is a separate service the user runs.
- Not a tmux replacement. Users still interact with their actual tmux session for terminal-mode work. The app provides chat-style, terminal-view, and plan-editor surfaces.
- Not a Tauri/desktop bundle anymore. The previous Svelte desktop app and Rust/Tauri implementation have been removed and replaced by `app/`.

### Runtime Verification Rule

For aimux runtime or CLI behavior, source-level validation is not enough.

- Changes under `src/*.ts` do not affect the running CLI until `yarn build` updates `dist/`.
- `yarn vitest` and `yarn typecheck` validate source correctness; they do not prove the live runtime changed.
- `yarn build` only updates this checkout. Plain `aimux` runs the installed bundle behind `~/.local/bin/aimux`; update it with a local release install:

```bash
AIMUX_RELEASE_VERSION=local-$(git rev-parse --short HEAD) yarn release:asset
ASSET="$(ls -t release/aimux-*.tar.gz | head -n 1)"
scripts/install.sh "$ASSET"
```

- Before asking someone to verify runtime behavior manually, always run:

```bash
yarn build
```

- If a daemon or project runtime is already running, rebuild alone may still leave stale processes alive; restart or reload the relevant runtime after the build.
- Use `aimux restart` as the normal post-build coherence repair. It restarts the daemon, re-ensures known project services, and reloads existing dashboards without killing agent tmux windows.
- Use `aimux doctor versions` to inspect daemon/project-service/dashboard build coherence.
- Use `aimux restart-runtime --open` only when the current project's managed tmux runtime itself must be torn down and rebuilt.
- Do not send a user to test behavior changes against stale `dist/`.

### Navigation Layer Rule

Aimux has multiple navigation layers. Do not assume a visible UI behavior is owned by the Node runtime.

- Dashboard subscreen navigation is one layer.
- Live pane prefix navigation inside tmux-managed agent/service windows is a different layer.

If a requested shortcut is described as behaving like an existing live-pane prefix shortcut such as `ctrl-a n/p`, treat the tmux control path as the default source of truth first:

- inspect `src/tmux/runtime-manager.ts`
- inspect `scripts/tmux-control.sh`
- inspect `src/tmux/control-script.test.ts`

Do not re-implement similar logic in `src/hotkeys.ts` or `src/multiplexer/session-launch.ts` unless the feature is explicitly meant to be owned by the in-process Node runtime. For live-pane, latency-sensitive navigation, prefer tmux-local metadata and tmux bindings over Node-side session lists.

### Releasing The App

Releases go through the shared `@tradersamwise/eas-release` CLI. There are two
paths, chosen by what changed. Always bump the version first, then ship.

OTA update — JavaScript / asset changes only, delivered over the existing native
build's Expo runtime:

```bash
cd app
yarn version:bump-ota && yarn update              # testflight
yarn version:bump-ota && yarn update:production   # production
```

Native build — required whenever the native binary or its Expo runtime fingerprint
changes (native dependencies, Expo plugins, permissions/entitlements, icons, splash
screen, build profiles, or any native `app.config.js` change):

```bash
yarn version:bump-build && yarn build:testflight   # testflight
yarn version:bump-build && yarn build:production    # production
yarn build --android      # Play/internal Android (pair with version:bump-build)
yarn build --all          # iOS + Android
```

Decision rule: OTA covers JS and assets; a native rebuild is required for native
deps, Expo plugins, permissions, icons, splash, build profiles, or native config.
`bump-ota` enforces this — it aborts if the Expo runtime version changed since the
last native build, because an OTA can only target the runtime already installed on
the device. `bump-build` increments the build number, resets the OTA counter to 0,
and updates native version files. Both commit the version file.

### GUI CLI Commands

The browser/mobile client calls daemon and project-service HTTP directly. The same operations are also available as CLI commands; flags `--project <path>` and `--json` apply where relevant:

- `aimux spawn --tool <tool> [--worktree <path>] --project <path>`: create new agent.
- `aimux stop <sessionId> --project <path>`: stop agent, running to offline.
- `aimux kill <sessionId> --project <path>`: kill agent, send to graveyard.
- `aimux fork <sourceSessionId> --tool <tool> [--worktree <path>] --project <path>`: fork agent.
- `aimux worktree create <name> --project <path>`: create worktree.
- `aimux worktree list --project <path> --json`: list worktrees.
- `aimux graveyard list --project <path> --json`: list dead agents.
- `aimux graveyard resurrect <id> --project <path>`: revive agent.
- `aimux message send <body> --project <path>`: send a thread message or direct coordination message.
- `aimux handoff send|accept|complete ... --project <path>`: create and resolve handoff workflow records.
- `aimux task assign|accept|block|complete|reopen ... --project <path>`: create and resolve task workflow records.
- `aimux review approve|request-changes ... --project <path>`: resolve review workflow records.
- `aimux thread list --project <path> --json`: inspect project thread/workflow state.
- `aimux host agent-read <sessionId> --project <path>`: read a tmux pane snapshot through the project service.
- `aimux host agent-stream <sessionId> --project <path>`: stream live pane output through project-service SSE.
