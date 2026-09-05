# Rust Translation Decisions v1

## Decision 1: Translation First

Date: 2026-09-05

TypeScript behavior is the spec until full parity is reached. Rust should copy
the current file/function/loop shape first, including awkward behavior.

## Decision 2: Zero Node End State

Date: 2026-09-05

The final normal installed CLI must not start Node. Compatibility shims are
allowed during translation only when a phase explicitly marks the surface as not
yet Rust-owned.
