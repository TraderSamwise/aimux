# Rust Translation Contracts v1

Rust must preserve these external contracts until an intentional difference is
recorded in `decisions-v1.md`.

| ID | Contract | TypeScript Spec | Native Owner | Gate |
| --- | --- | --- | --- | --- |
| CLI | CLI commands, stdout, stderr, exit codes | `src/main.ts`, `src/full/main.ts`, `src/core-cli.ts`, `src/core-command-contract.ts` | `native/crates/aimux/src/bin/aimux.rs` | command fixtures |
| DAEMON | daemon status, project catalog, proxy routes | `src/daemon.ts`, `src/daemon-state.ts`, `src/daemon/projects-route.ts` | `native/crates/aimux/src/daemon` | daemon JSON fixtures |
| PROJECT | project-service HTTP routes and SSE frames | `src/metadata-server.ts`, `src/metadata-server/*`, `src/project-api-contract.ts` | `native/crates/aimux/src/metadata_server` | route and SSE fixtures |
| TMUX | tmux metadata, targets, runtime contract, statusline/expose files | `src/tmux/*`, `src/runtime-owner.ts`, `scripts/tmux-statusline.sh` | `native/crates/aimux/src/tmux` | tmux argv/inventory fixtures |
| DASHBOARD | desktop-state, dashboard rows, key handling, TUI views | `src/multiplexer/*`, `src/dashboard/*`, `src/tui/*` | `native/crates/aimux/src/multiplexer`, `native/crates/aimux/src/tui` | desktop-state and render fixtures |
| EXCHANGE | tasks, handoffs, threads, reviews, topology, graveyard | `src/runtime-core/*`, `src/tasks.ts`, `src/threads.ts` | `native/crates/aimux/src/runtime_core` | store round-trip fixtures |
| OUTPUT | pane capture, ANSI spans, terminal display, transcript/liveness | `src/agent-output-parser.ts`, `src/multiplexer/session-capture.ts`, `app/lib/ansi.ts`, `app/lib/terminal-output.ts` | `native/crates/aimux/src/output` | adversarial output fixtures |
| RELEASE | install asset, doctor versions, runtime process shape | `scripts/build-release-asset.sh`, `scripts/install.sh`, `src/tmux/doctor.ts` | `native/crates/aimux/src/release` | zero-Node install fixture |
