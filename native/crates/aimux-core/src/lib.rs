//! The floor both halves of the product stand on.
//!
//! `aimux` (the local binary) and `aimux-remote` (the hosted/relay half) both
//! compile against this crate. Nothing here may reach back into either of
//! them: that is the whole point, because a module in here is a module a
//! security reviewer does not have to read twice.

pub mod async_runtime;
pub mod async_subprocess;
pub mod atomic_write;
pub mod backlog_metrics;
pub mod config;
pub mod debug_logging;
pub mod machine_identity;
pub mod paths;
pub mod secure_permissions;
