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

Svelte changes hot-reload instantly. Rust changes trigger a recompile + app restart (~3-5s).

### Building the .app bundle

Only build the bundle for final testing or distribution:

```bash
cd desktop-ui && npx vite build
cd src-tauri && cargo tauri build --debug
open target/debug/bundle/macos/Aimux\ Desktop.app
```

### Architecture

- `desktop-ui/` — Svelte 5 frontend (Vite build)
- `src-tauri/` — Rust backend (Tauri v2, PTY management, filesystem reads)
- Frontend talks to backend via Tauri `invoke()` commands
- Single `heartbeat` command polls all project state every 2s (reads `~/.aimux/projects.json` + per-project `statusline.json`)
- Auto-spawns `aimux serve` for projects without a running host
