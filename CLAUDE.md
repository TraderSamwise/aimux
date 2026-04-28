# Aimux Development Notes

## Desktop App (Tauri + Svelte)

### Development with HMR

**Always use the dev servers for iterating on the desktop UI.** Do NOT rebuild the `.app` bundle on every change.

```bash
# Terminal 1: Start Vite dev server (Svelte HMR on :1420)
cd desktop-ui && npx vite dev --port 1420

# Terminal 2: Start Tauri dev mode (compiles Rust, opens app pointing at Vite)
cd src-tauri && cargo tauri dev
```

**What triggers what:**
- `desktop-ui/` Svelte changes → HMR picks up instantly (no restart)
- `src-tauri/src/main.rs` Rust changes → `cargo tauri dev` auto-recompiles + restarts app
- `src/*.ts` Node CLI changes → need `yarn build` so the desktop app sees updated `dist/` code

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

### Building the .app bundle

Only build the bundle for final testing or distribution:

```bash
cd desktop-ui && npx vite build
cd src-tauri && cargo tauri build --debug
open target/debug/bundle/macos/Aimux\ Desktop.app
```

### Architecture

- `desktop-ui/` — Svelte 5 frontend (Vite build)
- `src-tauri/` — Rust backend (Tauri v2, PTY management, daemon CLI bridge)
- Frontend talks to backend via Tauri `invoke()` commands
- Single `heartbeat` command calls `aimux daemon ensure` + `aimux daemon projects --json` every 2s
- Per-project statusline read from `~/.aimux/projects/<id>/statusline.json`
- Global daemon manages per-project services (MetadataServer, PluginRuntime, statusline writing)
- Desktop app is a daemon client — does not manage project host ownership

### GUI CLI Commands

All commands support `--project <path>` and relevant ones support `--json`:

- `aimux spawn --tool <tool> --project <path> [--worktree <path>]` — create new agent
- `aimux stop <sessionId> --project <path>` — stop agent (running → offline)
- `aimux kill <sessionId> --project <path>` — kill agent (send to graveyard)
- `aimux fork <sourceSessionId> --tool <tool> [--worktree <path>] --project <path>` — fork agent
- `aimux worktree create <name> --project <path>` — create worktree
- `aimux worktree list --project <path> --json` — list worktrees
- `aimux graveyard list --project <path> --json` — list dead agents
- `aimux graveyard resurrect <id> --project <path>` — revive agent
- `aimux desktop focus --project <path> --session <id>` — focus agent in terminal
