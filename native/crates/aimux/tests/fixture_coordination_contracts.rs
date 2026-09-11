//! Aggregated coordination fixture contracts.
//!
//! These fixture modules used to be one integration-test binary per corpus.
//! Keep them grouped by subsystem so Cargo links aimux once per subsystem
//! while preserving the same contract assertions.

#[path = "fixtures/fixture_builtin_metadata_watchers.rs"]
mod fixture_builtin_metadata_watchers;
#[path = "fixtures/fixture_coordination_model.rs"]
mod fixture_coordination_model;
#[path = "fixtures/fixture_coordination_mutations.rs"]
mod fixture_coordination_mutations;
#[path = "fixtures/fixture_loop_watcher.rs"]
mod fixture_loop_watcher;
#[path = "fixtures/fixture_orchestration_actions.rs"]
mod fixture_orchestration_actions;
#[path = "fixtures/fixture_scribe_watcher.rs"]
mod fixture_scribe_watcher;
#[path = "fixtures/fixture_workflow_entries.rs"]
mod fixture_workflow_entries;
