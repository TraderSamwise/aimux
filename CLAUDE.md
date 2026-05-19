# Aimux Development Notes

## Product Context

Aimux is an agent multiplexer. It runs long-lived Claude, Codex, and shell sessions in tmux windows scoped to a project checkout or one of that project's git worktrees. The dashboard is the user-facing control plane for creating, entering, stopping, reviving, and coordinating those sessions.

Agents inside aimux coordinate through `.aimux/` files, not by directly spawning each other unless the user gives an explicit CLI command. Use `.aimux/tasks/*.json` only when the user explicitly asks for delegation or handoff. Do not proactively write `.aimux/plans/*` or `.aimux/status/*` for simple questions, read-only inspections, or one-shot tasks.

## App (`app/`) — Expo Router + RN + Web

The browser and native clients live in `app/`. Single Expo codebase targeting web, iOS, and Android.

### Development with HMR

```bash
cd app
yarn web      # web client served by Metro on http://localhost:8081, HMR
yarn ios      # iOS simulator (Expo Go or dev client)
yarn android  # Android emulator
```

**What triggers what:**
- `app/app/`, `app/components/`, `app/lib/`, `app/stores/` changes → Metro HMR (no restart)
- `src/*.ts` Node CLI changes → need `yarn build` at the repo root so the daemon and metadata server see updated `dist/` code
- The app is a pure HTTP+SSE client of the aimux daemon; it does NOT bundle the CLI

### App Architecture

- `app/app/` — Expo Router screens (file-based routing). `(main)` group is the authed app shell with project sidebar + chat/plans/threads screens.
- `app/lib/api.ts` — typed HTTP client. Daemon routes target `localhost:43190` by default; per-project metadata-server routes target the `serviceEndpoint` returned by `/projects`.
- `app/lib/heartbeat.ts` — `event-source-polyfill` wrapper for the per-project `/events` SSE stream. The polyfill auto-reconnects on transient failures.
- `app/stores/` — Zustand stores: `projects` (list + selection), `chat` (per-session history, pending, output, streaming), `ui` (sidebar).
- `app/lib/image-picker.{web,native}.ts` — platform-split. Web uses `<input type=file>`; native uses `expo-image-picker`.

### What the app is NOT

- NOT a daemon owner. The app is a client; it cannot start, restart, or repair the daemon. The daemon is a separate service the user runs.
- NOT a tmux replacement. Users still interact with their actual tmux session for terminal-mode work. The app provides chat-style and plan-editor surfaces only.
- NOT a Tauri/desktop bundle anymore. The previous `desktop-ui/` (Svelte) + `src-tauri/` (Rust/Tauri) implementation has been replaced.

### Runtime Verification Rule

For `aimux` runtime / CLI behavior, source-level validation is not enough.

- Changes under `src/*.ts` do not affect the running CLI until `yarn build` updates `dist/`
- `yarn vitest` and `yarn typecheck` only validate source correctness; they do not prove the live runtime changed
- Before asking someone to verify runtime behavior manually, always:

```bash
yarn build
```

- If a daemon or project runtime is already running, rebuild alone may still leave stale processes alive; restart or reload the relevant runtime after the build
- Do not send a user to test behavior changes against stale `dist/`

### Navigation Layer Rule

Aimux has multiple navigation layers. Do not assume a visible UI behavior is owned by the Node runtime.

- Dashboard subscreen navigation is one layer
- Live pane prefix navigation inside tmux-managed agent/service windows is a different layer

If a requested shortcut is described as behaving like an existing live-pane prefix shortcut such as `ctrl-a n/p`, treat the tmux control path as the default source of truth first:

- inspect [src/tmux/runtime-manager.ts](src/tmux/runtime-manager.ts)
- inspect [scripts/tmux-control.sh](scripts/tmux-control.sh)
- inspect [src/tmux/control-script.test.ts](src/tmux/control-script.test.ts)

Do not re-implement “similar logic” in `src/hotkeys.ts` or `src/multiplexer/session-launch.ts` unless the feature is explicitly meant to be owned by the in-process Node runtime. For live-pane, latency-sensitive navigation, prefer tmux-local metadata and tmux bindings over Node-side session lists.

### Building the native bundle

For distribution, EAS produces native bundles via the `app/scripts/build.sh` pipeline:

```bash
cd app
yarn build:testflight   # TestFlight (iOS, default channel)
yarn build:production   # production (App Store / Play)
```

OTA-only updates skip the native rebuild:

```bash
cd app
yarn update             # testflight channel
yarn update:production
```

### GUI CLI Commands (the daemon HTTP surface)

The browser/mobile client calls daemon and project-service HTTP directly. The same operations are also available as CLI commands; flags `--project <path>` and `--json` apply where relevant:

- `aimux spawn --tool <tool> [--worktree <path>] --project <path>` — create new agent
- `aimux stop <sessionId> --project <path>` — stop agent (running → offline)
- `aimux kill <sessionId> --project <path>` — kill agent (send to graveyard)
- `aimux fork <sourceSessionId> --tool <tool> [--worktree <path>] --project <path>` — fork agent
- `aimux worktree create <name> --project <path>` — create worktree
- `aimux worktree list --project <path> --json` — list worktrees
- `aimux graveyard list --project <path> --json` — list dead agents
- `aimux graveyard resurrect <id> --project <path>` — revive agent
