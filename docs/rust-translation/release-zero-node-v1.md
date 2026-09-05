# Zero Node Runtime Release Gate v1

Passing gate: after the Rust runtime is selected for release, a normal installed
Aimux runtime starts no Node process outside the GUI app toolchain.

Allowed JavaScript:
- Expo/mobile/web GUI source and build tooling.
- One-off development scripts that do not ship in the installed runtime.

Disallowed in installed runtime:
- `bin/aimux` invoking `node`.
- `scripts/install.sh` requiring Node.
- `scripts/installed-aimux-shim.sh` executing `dist/launcher-bin.js`.
- Daemon, project-service, tmux dashboard, doctor, repair, or CLI fallback
  process commands using Node.
- Release archive contents requiring `node_modules` for runtime execution.

Known TypeScript gates to flip:
- `src/one-shot-node-inventory.test.ts`
- `src/installed-shim.test.ts`
- `src/cli-launcher.test.ts`
- `src/dashboard/command-spec.test.ts`
- `src/runtime-coherence.test.ts`
- `src/runtime-restart.test.ts`

Acceptance commands:
- `yarn native:fmt:check`
- `yarn native:test`
- `cargo clippy --manifest-path native/Cargo.toml --all-targets -- -D warnings`
- native release asset inspection: no runtime `node`, `AIMUX_NODE_BIN`,
  `dist/launcher-bin.js`, or runtime `node_modules` dependency.
- installed smoke: `aimux doctor versions`, `aimux daemon status --json`,
  `aimux projects list --json`, and `aimux ps --json` without Node runtime
  processes outside GUI.
