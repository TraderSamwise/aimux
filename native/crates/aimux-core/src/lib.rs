//! The floor both halves of the product stand on.
//!
//! `aimux` (the local binary) and `aimux-remote` (the hosted/relay half) both
//! compile against this crate. Nothing here may reach back into either of
//! them: that is the whole point, because a module in here is a module a
//! security reviewer does not have to read twice.

pub mod agent_display;
pub mod async_runtime;
pub mod async_subprocess;
pub mod atomic_write;
pub mod attachment_uploader;
pub mod backlog_metrics;
pub mod config;
pub mod core_cli_routing;
pub mod core_command_contract;
pub mod core_text;
pub mod debug_logging;
pub mod launcher_env;
pub mod machine_identity;
pub mod paths;
pub mod periodic_scheduler;
pub mod project_api_contract;
pub mod project_route;
pub mod proxy_project_binding;
pub mod request_actor;
pub mod secure_permissions;
pub mod wire;
