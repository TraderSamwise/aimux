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

Agents inside aimux coordinate through `.aimux/` files, not by directly spawning each other unless the user gives an explicit CLI command. Use `.aimux/tasks/*.json` only when the user explicitly asks for delegation or handoff. Do not proactively write `.aimux/plans/*` or `.aimux/status/*` for simple questions, read-only inspections, or one-shot tasks.

## App (`app/`) - Expo Router + RN + Web

The browser and native clients live in `app/`. Single Expo codebase targeting web, iOS, and Android.

### Development With HMR

```bash
cd app
yarn web      # web client served by Metro on http://localhost:8081, HMR
yarn ios      # iOS simulator (Expo Go or dev client)
yarn android  # Android emulator
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
- Not a Tauri/desktop bundle anymore. The previous `desktop-ui/` Svelte app and `src-tauri/` Rust/Tauri implementation have been replaced.

### Runtime Verification Rule

For aimux runtime or CLI behavior, source-level validation is not enough.

- Changes under `src/*.ts` do not affect the running CLI until `yarn build` updates `dist/`.
- `yarn vitest` and `yarn typecheck` validate source correctness; they do not prove the live runtime changed.
- Before asking someone to verify runtime behavior manually, always run:

```bash
yarn build
```

- If a daemon or project runtime is already running, rebuild alone may still leave stale processes alive; restart or reload the relevant runtime after the build.
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

### Building The Native Bundle

For distribution, EAS produces native bundles via the `app/scripts/build.sh` pipeline:

```bash
cd app
yarn build:testflight   # TestFlight, iOS default channel
yarn build:production   # production, App Store / Play
```

OTA-only updates skip the native rebuild:

```bash
cd app
yarn update
yarn update:production
```

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
