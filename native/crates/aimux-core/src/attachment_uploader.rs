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

pub const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;

/// What the service says when a decoded attachment is over the policy.
///
/// Derived, because written as a literal it kept saying "10 MB" whatever the
/// constant became, and nothing noticed.
pub fn attachment_too_large_message() -> String {
    format!(
        "attachment exceeds {} MB",
        MAX_ATTACHMENT_BYTES / (1024 * 1024)
    )
}

/// The request body an upload of `MAX_ATTACHMENT_BYTES` actually needs.
///
/// The bytes arrive base64 in a JSON body, so the budget is the 4/3 expansion
/// plus the envelope -- `kind`, `filename`, `mimeType`, `sessionId` and the
/// JSON itself. Derived rather than written down twice: the body cap used to
/// be a flat 1 MiB for every route, which rejected an upload at about 786 KB
/// of image and made the 10 MB limit this module declares unreachable. The
/// limit that fires should be the limit that is written down.
pub fn attachment_upload_body_limit() -> usize {
    const ENVELOPE_BYTES: usize = 8 * 1024;
    MAX_ATTACHMENT_BYTES.div_ceil(3) * 4 + ENVELOPE_BYTES
}
