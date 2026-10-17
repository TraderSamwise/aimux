//! The seam an attachment uploader is plugged into.
//!
//! Only the trait and its timeout live here, because only they have to be
//! nameable from the crate that implements them. Everything that decides
//! whether and what to upload -- reading the file, validating the relay URL,
//! reading the relay's answer -- stays in the local crate's
//! `attachment_hosting`, so this shared crate carries no local file read and
//! no credential.

use serde_json::Value;

/// Longest we wait for the relay to take an upload. Publishing is interactive,
/// so a stalled relay must fail the hosting rather than the publish.
pub const UPLOAD_TIMEOUT_SECS: u64 = 15;

/// What the uploader needs, so the decision logic can be tested without a relay.
pub trait AttachmentUploader {
    fn post_json(&self, url: &str, token: &str, body: &Value) -> Result<(u16, Value), String>;
}
