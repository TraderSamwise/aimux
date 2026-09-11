//! Aggregated agent fixture contracts.
//!
//! These fixture modules used to be one integration-test binary per corpus.
//! Keep them grouped by subsystem so Cargo links aimux once per subsystem
//! while preserving the same contract assertions.

#[path = "fixtures/fixture_agent_display.rs"]
mod fixture_agent_display;
#[path = "fixtures/fixture_agent_output_io.rs"]
mod fixture_agent_output_io;
#[path = "fixtures/fixture_agent_output_parser.rs"]
mod fixture_agent_output_parser;
#[path = "fixtures/fixture_agent_state.rs"]
mod fixture_agent_state;
#[path = "fixtures/fixture_agent_transcript.rs"]
mod fixture_agent_transcript;
#[path = "fixtures/fixture_ansi_sgr.rs"]
mod fixture_ansi_sgr;
#[path = "fixtures/fixture_backend_session_discovery.rs"]
mod fixture_backend_session_discovery;
#[path = "fixtures/fixture_relay_client.rs"]
mod fixture_relay_client;
#[path = "fixtures/fixture_rich_text.rs"]
mod fixture_rich_text;
#[path = "fixtures/fixture_transcript_reconciler.rs"]
mod fixture_transcript_reconciler;
#[path = "fixtures/fixture_transcript_turn_state.rs"]
mod fixture_transcript_turn_state;
