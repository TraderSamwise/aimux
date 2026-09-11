//! Aggregated runtime fixture contracts.
//!
//! These fixture modules used to be one integration-test binary per corpus.
//! Keep them grouped by subsystem so Cargo links aimux once per subsystem
//! while preserving the same contract assertions.

#[path = "fixtures/fixture_atomic_write.rs"]
mod fixture_atomic_write;
#[path = "fixtures/fixture_attachment_store.rs"]
mod fixture_attachment_store;
#[path = "fixtures/fixture_config_behavior.rs"]
mod fixture_config_behavior;
#[path = "fixtures/fixture_paths_behavior.rs"]
mod fixture_paths_behavior;
#[path = "fixtures/fixture_priority2.rs"]
mod fixture_priority2;
#[path = "fixtures/fixture_process_inspector.rs"]
mod fixture_process_inspector;
#[path = "fixtures/fixture_runtime_coherence.rs"]
mod fixture_runtime_coherence;
#[path = "fixtures/fixture_runtime_exchange_import.rs"]
mod fixture_runtime_exchange_import;
#[path = "fixtures/fixture_runtime_exchange_store.rs"]
mod fixture_runtime_exchange_store;
#[path = "fixtures/fixture_runtime_guard_repair.rs"]
mod fixture_runtime_guard_repair;
#[path = "fixtures/fixture_runtime_guard_sync.rs"]
mod fixture_runtime_guard_sync;
#[path = "fixtures/fixture_runtime_lifecycle_methods.rs"]
mod fixture_runtime_lifecycle_methods;
#[path = "fixtures/fixture_runtime_migration_contract.rs"]
mod fixture_runtime_migration_contract;
#[path = "fixtures/fixture_runtime_topology_worktrees_services.rs"]
mod fixture_runtime_topology_worktrees_services;
#[path = "fixtures/fixture_session_bootstrap.rs"]
mod fixture_session_bootstrap;
#[path = "fixtures/fixture_session_semantics.rs"]
mod fixture_session_semantics;
#[path = "fixtures/fixture_shell_hooks.rs"]
mod fixture_shell_hooks;
#[path = "fixtures/fixture_source_boundaries.rs"]
mod fixture_source_boundaries;
#[path = "fixtures/fixture_team_semantics.rs"]
mod fixture_team_semantics;
#[path = "fixtures/fixture_transport_security.rs"]
mod fixture_transport_security;
