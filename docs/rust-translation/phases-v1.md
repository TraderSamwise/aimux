# Rust Translation Phases v1

| Phase | Status | Objective | Gate |
| --- | --- | --- | --- |
| Phase 0 | complete | Native workspace, parity contract manifest, and progress tracking | `cargo fmt`, `cargo test`, `cargo run -p aimux -- rewrite status --json` |
| Phase 1 | planned | Pure contracts and data models | Rust model JSON matches TypeScript fixtures |
| Phase 2 | planned | CLI/core command text and JSON parity | CLI stdout, stderr, and exit codes match |
| Phase 3 | planned | Project-service HTTP/SSE behavior | Project API route and SSE fixtures match |
| Phase 4 | planned | Tmux runtime/session mechanics | Live tmux inventory diff matches TypeScript |
| Phase 5 | planned | Output capture, ANSI parsing, transcript reconciliation, previews | Adversarial output fixtures match |
| Phase 6 | planned | Runtime exchange mutations, tasks, handoffs, threads, reviews | Store round-trip fixtures match |
| Phase 7 | planned | Dashboard TUI and app/relay integration parity | Dashboard model and route fixtures match |
| Phase 8 | planned | Native release/install cutover and TypeScript retirement | Normal installed CLI starts no Node process |
