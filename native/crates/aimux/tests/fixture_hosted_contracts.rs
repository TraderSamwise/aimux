//! Aggregated hosted runtime fixture contracts.
//!
//! These fixture modules used to be one integration-test binary per corpus.
//! Keep them grouped by subsystem so Cargo links aimux once per subsystem
//! while preserving the same contract assertions.

#[path = "fixtures/fixture_hosted_audit.rs"]
mod fixture_hosted_audit;
#[path = "fixtures/fixture_hosted_events_transport.rs"]
mod fixture_hosted_events_transport;
#[path = "fixtures/fixture_hosted_principals.rs"]
mod fixture_hosted_principals;
#[path = "fixtures/fixture_hosted_runtime.rs"]
mod fixture_hosted_runtime;
#[path = "fixtures/fixture_hosted_security.rs"]
mod fixture_hosted_security;
#[path = "fixtures/fixture_remote_access.rs"]
mod fixture_remote_access;
