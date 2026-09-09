# Rust Translation Phases v1

| Phase | Status | Objective | Gate |
| --- | --- | --- | --- |
| Phase 0 | complete | Native workspace, parity contract manifest, and progress tracking | `cargo fmt`, `cargo test`, `cargo run -p aimux -- rewrite status --json` |
| Phase 1 | complete | Pure contracts and data models | Rust model JSON matches committed corpora |
| Phase 2 | complete | CLI/core command text and JSON parity | CLI stdout, stderr, exit codes, and live front-door smokes pass |
| Phase 3 | complete | Project-service HTTP/SSE behavior | Project API route and SSE fixtures match committed corpora |
| Phase 4 | complete | Tmux runtime/session mechanics | Live tmux residuals and committed tmux fixtures pass |
| Phase 5 | complete | Output capture, ANSI parsing, transcript reconciliation, previews | Adversarial output fixtures match committed corpora |
| Phase 6 | complete | Runtime exchange mutations, tasks, handoffs, threads, reviews | Store round-trip fixtures match committed corpora |
| Phase 7 | complete | Dashboard TUI and app/relay integration parity | Dashboard model, route fixtures, and live render/input smokes pass |
| Phase 8 | complete | Native release/install cutover and TypeScript retirement | Normal installed CLI starts no Node process and retired TS graph is deleted |
