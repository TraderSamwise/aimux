//! Aggregated plugin fixture contracts.
//!
//! These fixture modules used to be one integration-test binary per corpus.
//! Keep them grouped by subsystem so Cargo links aimux once per subsystem
//! while preserving the same contract assertions.

#[path = "fixtures/fixture_plugin_api.rs"]
mod fixture_plugin_api;
#[path = "fixtures/fixture_plugin_runtime.rs"]
mod fixture_plugin_runtime;
#[path = "fixtures/fixture_tool_output_watchers.rs"]
mod fixture_tool_output_watchers;
