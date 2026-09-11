//! Aggregated daemon fixture contracts.
//!
//! These fixture modules used to be one integration-test binary per corpus.
//! Keep them grouped by subsystem so Cargo links aimux once per subsystem
//! while preserving the same contract assertions.

#[path = "fixtures/fixture_daemon_projects_route.rs"]
mod fixture_daemon_projects_route;
#[path = "fixtures/fixture_daemon_state.rs"]
mod fixture_daemon_state;
#[path = "fixtures/fixture_daemon_supervisor_build.rs"]
mod fixture_daemon_supervisor_build;
#[path = "fixtures/fixture_debug_state.rs"]
mod fixture_debug_state;
#[path = "fixtures/fixture_event_loop.rs"]
mod fixture_event_loop;
#[path = "fixtures/fixture_fast_control.rs"]
mod fixture_fast_control;
