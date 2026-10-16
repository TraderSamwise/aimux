//! The uploader that actually reaches the relay.
//!
//! The decision about whether and what to upload is local -- see
//! `crate::attachment_hosting`, which a reviewer can read without reading
//! this. This is the part that needs an HTTP client, and it is the only reason
//! `ureq` was ever a dependency of the local build.

use serde_json::Value;

use crate::attachment_hosting::{AttachmentUploader, UPLOAD_TIMEOUT_SECS};

pub struct HttpAttachmentUploader;

impl AttachmentUploader for HttpAttachmentUploader {
    fn post_json(&self, url: &str, token: &str, body: &Value) -> Result<(u16, Value), String> {
        let response = ureq::post(url)
            .timeout(std::time::Duration::from_secs(UPLOAD_TIMEOUT_SECS))
            .set("authorization", &format!("Bearer {token}"))
            .set("content-type", "application/json")
            .send_string(&body.to_string());
        match response {
            Ok(response) => {
                let status = response.status();
                let json = response.into_json::<Value>().unwrap_or(Value::Null);
                Ok((status, json))
            }
            // A 4xx/5xx is an answer, not a transport failure: the relay's own
            // error message is more useful than "request failed".
            Err(ureq::Error::Status(status, response)) => {
                let json = response.into_json::<Value>().unwrap_or(Value::Null);
                Ok((status, json))
            }
            Err(error) => Err(error.to_string()),
        }
    }
}
