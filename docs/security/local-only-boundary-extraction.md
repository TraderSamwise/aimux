# Local-Only Boundary Extraction Notes

This note records the intended follow-up shape for the source-review boundary
after the shrink-only pass. Do not treat this as approval to start the crate
split in the same change.

## Current Proof Points

- The local build boundary must use `#[cfg(...)]` attributes, not the `cfg!`
  macro. `rg -n 'cfg!\(feature = .remote-control.\)' native/crates/aimux/src`
  must stay empty because `cfg!` would compile both branches into the local
  binary.
- A local/no-default release binary must contain zero remote-control surface
  strings for `tungstenite` and `wss://`.
- A full/default release binary should still contain those remote-control
  strings, proving the comparison is checking a real distinction.
- The shrink-only pass must not turn code that was compiled out into runtime
  branches or unused compiled code.

## Extraction Shape

Use `native/crates/aimux/src/daemon/remote_control.rs` as the main dependency
edge between the daemon and a future remote-control crate. The far side of that
edge should own:

- `remote/*`
- relay auth and login flows
- hosted server lifecycle
- mobile push bridge
- relay attachment hosting implementation

The difficult files are `native/crates/aimux/src/daemon/runtime.rs` and
`native/crates/aimux/src/remote/hosted_server.rs`. `runtime.rs` currently owns
the relay fields, auth-flow state, startup reconnect, scheduler injection,
hosted-server startup, and push delivery. `hosted_server.rs` couples the hosted
relay surface to daemon scheduler callbacks and runtime state. Those ownership
edges make the full split more than a mechanical cleanup.
