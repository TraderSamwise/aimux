//! The one place a Linear request reaches the network.
//!
//! Everything decidable without a socket is in `linear_api`; this is the
//! socket. Same shape as `attachment_upload.rs`, and for the same reason: the
//! protocol stays provable and the dependency stays on this side of the edge.

use serde_json::Value;

use crate::linear_api::{LINEAR_API_URL, LINEAR_TIMEOUT_SECS, LinearApi};

pub struct HttpLinearApi;

impl LinearApi for HttpLinearApi {
    fn post_graphql(&self, token: &str, body: &Value) -> Result<(u16, Value), String> {
        let response = ureq::post(LINEAR_API_URL)
            .timeout(std::time::Duration::from_secs(LINEAR_TIMEOUT_SECS))
            .set("authorization", token)
            .set("content-type", "application/json")
            .send_string(&body.to_string());
        match response {
            Ok(response) => {
                let status = response.status();
                let json = response.into_json::<Value>().unwrap_or(Value::Null);
                Ok((status, json))
            }
            // A 4xx/5xx is an ANSWER, not a transport failure, and Linear's
            // own body explains it better than "request failed" -- the parser
            // in `linear_api` needs both halves to tell an auth refusal from a
            // rejected query.
            Err(ureq::Error::Status(status, response)) => {
                let json = response.into_json::<Value>().unwrap_or(Value::Null);
                Ok((status, json))
            }
            // Never arrived. The reason is passed through verbatim; the caller
            // turns it into `Unreachable` rather than an empty answer.
            //
            // `ureq` builds this message from the URL and the transport error,
            // never from the request headers, so the token cannot ride along.
            Err(error) => Err(error.to_string()),
        }
    }
}
