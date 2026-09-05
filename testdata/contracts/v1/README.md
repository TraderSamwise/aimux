# Aimux Contract Fixtures v1

This directory is the shared fixture root for TypeScript-to-Rust parity tests.
Fixtures here must be consumable by both Vitest and `cargo test`.

Golden updates must be explicit. Use `UPDATE_CONTRACT_GOLDENS=1` only in tests
that intentionally support rewriting expected outputs.

Priority fixture groups:

1. `project-api`: route shapes, mutation invalidations, HTTP/SSE payloads.
2. `agent-output`: parser fixtures, streaming diffs, liveness transitions.
3. `ansi`: SGR spans and terminal display formatting.
4. `tmux`: command argv, inventory rows, pane captures, statusline artifacts.
5. `project-catalog`: registry, topology, desktop-state project summaries.
