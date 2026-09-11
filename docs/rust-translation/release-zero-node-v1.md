# Zero Node Runtime Release Gate v1

Passing gate: after the Rust runtime is selected for release, a normal installed
Aimux runtime starts no Node process outside the GUI app toolchain.

Allowed JavaScript:
- Expo/mobile/web GUI source and build tooling.
- Hosted relay source and build tooling that does not ship in the installed
  local runtime.
- One-off development scripts that do not ship in the installed runtime.

Disallowed in installed runtime:
- `bin/aimux` invoking `node`.
- `scripts/install.sh` requiring Node.
- `scripts/installed-aimux-shim.sh` executing `dist/launcher-bin.js`.
- Daemon, project-service, tmux dashboard, doctor, repair, or CLI fallback
  process commands using Node.
- Release archive contents requiring `node_modules` for runtime execution.

Retired TypeScript gates:
- The old runtime TypeScript tests and capture harness were removed in Phase 8.
- Their surviving evidence is the committed corpora under `testdata/contracts/v1`
  plus Rust fixture consumers and live residual seams.
- Native release/install behavior is now covered by Rust tests such as
  `native/crates/aimux/tests/release_zero_node.rs`, fixture-backed release
  contracts, and the post-cut no-Node smoke evidence.

Acceptance commands:
- `yarn verify:full`
- blocking CI: Rust format, Rust clippy all targets, Rust tests (macOS),
  JavaScript tests (root/relay), JavaScript tests (app), and Phase 8 live
  residuals.
- advisory CI: Rust tests (Linux), pending the desktop notification transport
  platform decision.
- native release asset inspection: no runtime `node`, `AIMUX_NODE_BIN`,
  `dist/launcher-bin.js`, or runtime `node_modules` dependency.
- installed smoke: `aimux doctor versions`, `aimux daemon status --json`,
  `aimux projects list --json`, and `aimux ps --json` without Node runtime
  processes outside GUI.
