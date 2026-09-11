//! Aggregated cli and core command fixture contracts.
//!
//! These fixture modules used to be one integration-test binary per corpus.
//! Keep them grouped by subsystem so Cargo links aimux once per subsystem
//! while preserving the same contract assertions.

#[path = "fixtures/fixture_cli_agent_id.rs"]
mod fixture_cli_agent_id;
#[path = "fixtures/fixture_cli_attachment.rs"]
mod fixture_cli_attachment;
#[path = "fixtures/fixture_cli_launcher.rs"]
mod fixture_cli_launcher;
#[path = "fixtures/fixture_cli_parsing.rs"]
mod fixture_cli_parsing;
#[path = "fixtures/fixture_cli_team.rs"]
mod fixture_cli_team;
#[path = "fixtures/fixture_cli_top_level_dispatch.rs"]
mod fixture_cli_top_level_dispatch;
#[path = "fixtures/fixture_cli_wrappers.rs"]
mod fixture_cli_wrappers;
#[path = "fixtures/fixture_core_command_behavior.rs"]
mod fixture_core_command_behavior;
#[path = "fixtures/fixture_core_command_ownership.rs"]
mod fixture_core_command_ownership;
#[path = "fixtures/fixture_core_command_transport.rs"]
mod fixture_core_command_transport;
#[path = "fixtures/fixture_metadata_cli_routing.rs"]
mod fixture_metadata_cli_routing;
