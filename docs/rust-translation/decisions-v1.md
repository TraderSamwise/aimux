# Rust Translation Decisions v1

## Decision 1: Translation First

Date: 2026-09-05

TypeScript behavior was the spec until full parity was reached. Rust initially
copied the current file/function/loop shape first, including awkward behavior.
After Phase 8, the Rust runtime is the product source of truth; Node remains a
recoverable reference for intentional compatibility questions, not a backlog of
features to preserve.

## Decision 2: Zero Node End State

Date: 2026-09-05

The final normal installed CLI must not start Node. Compatibility shims are
allowed during translation only when a phase explicitly marks the surface as not
yet Rust-owned.
