//! Aggregated project service fixture contracts.
//!
//! These fixture modules used to be one integration-test binary per corpus.
//! Keep them grouped by subsystem so Cargo links aimux once per subsystem
//! while preserving the same contract assertions.

#[path = "support/mod.rs"]
mod support;

#[path = "fixtures/fixture_inbox_cleanup.rs"]
mod fixture_inbox_cleanup;
#[path = "fixtures/fixture_inbox_cleanup_runtime.rs"]
mod fixture_inbox_cleanup_runtime;
#[path = "fixtures/fixture_last_used.rs"]
mod fixture_last_used;
#[path = "fixtures/fixture_library_entries.rs"]
mod fixture_library_entries;
#[path = "fixtures/fixture_metadata_server_helpers.rs"]
mod fixture_metadata_server_helpers;
#[path = "fixtures/fixture_metadata_server_runtime.rs"]
mod fixture_metadata_server_runtime;
#[path = "fixtures/fixture_metadata_store.rs"]
mod fixture_metadata_store;
#[path = "fixtures/fixture_notifications_store.rs"]
mod fixture_notifications_store;
#[path = "fixtures/fixture_operation_failures.rs"]
mod fixture_operation_failures;
#[path = "fixtures/fixture_project_api_behavior.rs"]
mod fixture_project_api_behavior;
#[path = "fixtures/fixture_project_catalog_registry.rs"]
mod fixture_project_catalog_registry;
#[path = "fixtures/fixture_project_event_stream.rs"]
mod fixture_project_event_stream;
#[path = "fixtures/fixture_project_observability.rs"]
mod fixture_project_observability;
#[path = "fixtures/fixture_project_scanner.rs"]
mod fixture_project_scanner;
#[path = "fixtures/fixture_prompt_context.rs"]
mod fixture_prompt_context;
#[path = "fixtures/fixture_proxy_project_binding.rs"]
mod fixture_proxy_project_binding;
#[path = "fixtures/fixture_recordings.rs"]
mod fixture_recordings;
#[path = "fixtures/fixture_service_client.rs"]
mod fixture_service_client;
#[path = "fixtures/fixture_service_notify.rs"]
mod fixture_service_notify;
#[path = "fixtures/fixture_service_state_snapshot.rs"]
mod fixture_service_state_snapshot;
#[path = "fixtures/fixture_work_outline.rs"]
mod fixture_work_outline;
#[path = "fixtures/fixture_worktree_cache_cleanup.rs"]
mod fixture_worktree_cache_cleanup;
#[path = "fixtures/fixture_worktree_colors.rs"]
mod fixture_worktree_colors;
