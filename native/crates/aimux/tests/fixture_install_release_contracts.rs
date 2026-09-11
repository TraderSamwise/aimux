//! Aggregated install and release fixture contracts.
//!
//! These fixture modules used to be one integration-test binary per corpus.
//! Keep them grouped by subsystem so Cargo links aimux once per subsystem
//! while preserving the same contract assertions.

#[path = "fixtures/fixture_release_contracts.rs"]
mod fixture_release_contracts;

#[path = "fixtures/fixture_install_cleanup.rs"]
mod fixture_install_cleanup;
#[path = "fixtures/fixture_install_doctor.rs"]
mod fixture_install_doctor;
#[path = "fixtures/fixture_installed_shim.rs"]
mod fixture_installed_shim;
#[path = "fixtures/fixture_launcher_env.rs"]
mod fixture_launcher_env;
#[path = "fixtures/fixture_managed_launch_env.rs"]
mod fixture_managed_launch_env;
#[path = "fixtures/fixture_package_manifest.rs"]
mod fixture_package_manifest;
#[path = "fixtures/fixture_release_asset.rs"]
mod fixture_release_asset;
#[path = "fixtures/fixture_version_contract.rs"]
mod fixture_version_contract;
