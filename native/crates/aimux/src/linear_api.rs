//! Talking to Linear's GraphQL API, and the part of it that is decidable
//! without a network.
//!
//! Split the way `attachment_hosting` is split: what we decide to send and how
//! we read the answer live here and are provable; the thing that actually makes
//! the request is one dependency edge away in `remote/linear_http.rs`, behind
//! the same `ureq` feature. A reviewer reading this file sees the whole
//! protocol without a client in the way.

use serde_json::{Value, json};

/// How long a Linear call may take before we give up on it.
///
/// Short on purpose: this is reached from a status route, and a person asking
/// whether their token works would rather be told "unreachable" quickly than
/// wait on a hung socket.
pub const LINEAR_TIMEOUT_SECS: u64 = 10;

pub const LINEAR_API_URL: &str = "https://api.linear.app/graphql";

/// What came back from Linear.
///
/// Five outcomes, and the reason they are not folded together is that a caller
/// does something different with each: a rejected query is a bug in our
/// request, an unauthorized one is the token, a rate limit is "wait", a server
/// error is "wait but not our fault", and unreachable never arrived.
/// Collapsing any of them into an empty value would make a failure read as an
/// account with no work in it -- which is exactly the shape AGENTS.md calls a
/// lie, because it cannot be told from real data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinearCall<T> {
    /// Linear answered, and this is the answer. It may legitimately be empty:
    /// a project with no issues is a TRUE "succeeded with nothing".
    Ok(T),
    /// The token was refused. Not retryable without a new token.
    Unauthorized,
    /// Linear asked us to slow down, with its hint if it sent one.
    RateLimited { retry_after_secs: Option<u64> },
    /// Linear is unwell. Retryable, and not our request's fault.
    ServerError { status: u16 },
    /// The request arrived and Linear reported errors against it. These are
    /// OUR bugs: a bad field, a bad id, a mutation it refused.
    Rejected(Vec<String>),
    /// It never got there. Carries why.
    Unreachable(String),
}

impl<T> LinearCall<T> {
    /// The answer, or nothing -- for a caller that genuinely does not care why.
    ///
    /// Deliberately not used internally: every call site that reaches for this
    /// is discarding the distinction this enum exists to carry, so it should be
    /// visible in the diff.
    pub fn ok(self) -> Option<T> {
        match self {
            LinearCall::Ok(value) => Some(value),
            _ => None,
        }
    }

    /// One line for a person, naming what went wrong.
    pub fn failure_line(&self) -> Option<String> {
        match self {
            LinearCall::Ok(_) => None,
            LinearCall::Unauthorized => {
                Some("Linear refused the token. It may be revoked or wrong.".to_owned())
            }
            LinearCall::RateLimited { retry_after_secs } => Some(match retry_after_secs {
                Some(secs) => format!("Linear is rate limiting us; it suggests {secs}s."),
                None => "Linear is rate limiting us.".to_owned(),
            }),
            LinearCall::ServerError { status } => Some(format!(
                "Linear returned {status}; this is its end, not ours."
            )),
            LinearCall::Rejected(errors) => {
                Some(format!("Linear rejected the query: {}", errors.join("; ")))
            }
            LinearCall::Unreachable(reason) => Some(format!("Could not reach Linear: {reason}")),
        }
    }
}

/// The thing that makes the request. Implemented once, over the network.
///
/// Takes the token as its own argument rather than letting the caller build an
/// authorization header, so there is exactly one place a token becomes a header
/// and nowhere for it to be logged on the way.
pub trait LinearApi {
    fn post_graphql(&self, token: &str, body: &Value) -> Result<(u16, Value), String>;
}

/// Read Linear's answer.
///
/// The rule that matters: **HTTP 200 with an `errors` array is a FAILURE.**
/// GraphQL reports query errors with a 200, so a parser that keys on the
/// status code alone returns `Ok` for a query that did nothing. That is the
/// single most common way a GraphQL client lies about its own result.
pub fn parse_graphql_response(status: u16, body: &Value) -> LinearCall<Value> {
    // Checked before the status, because Linear answers a rejected query with
    // 200 and a 400 can still carry useful errors.
    let errors = body.get("errors").and_then(Value::as_array);
    if let Some(errors) = errors.filter(|errors| !errors.is_empty()) {
        // An auth failure can arrive as a GraphQL error rather than a bare
        // 401, and calling that "a bug in our query" would send somebody to
        // rewrite a query when the token is the problem.
        if status == 401 || status == 403 {
            return LinearCall::Unauthorized;
        }
        let messages = errors
            .iter()
            .map(|error| {
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("an error with no message")
                    .to_owned()
            })
            .collect();
        return LinearCall::Rejected(messages);
    }

    match status {
        401 | 403 => return LinearCall::Unauthorized,
        429 => {
            return LinearCall::RateLimited {
                retry_after_secs: body
                    .get("retryAfter")
                    .and_then(Value::as_u64)
                    .or_else(|| body.get("retry_after").and_then(Value::as_u64)),
            };
        }
        500..=599 => return LinearCall::ServerError { status },
        _ => {}
    }

    match body.get("data") {
        // `data: null` with no errors is malformed rather than empty: Linear
        // does not answer that way, and treating it as an empty result would
        // invent an account with no work in it.
        None | Some(Value::Null) => LinearCall::Rejected(vec![format!(
            "Linear returned {status} with neither data nor errors"
        )]),
        Some(data) => LinearCall::Ok(data.clone()),
    }
}

/// Who the token belongs to. The cheapest call that proves a credential works.
pub fn viewer_query() -> Value {
    json!({ "query": "query { viewer { id name email } }" })
}

/// The issues in one project, by project NAME, because that is what goes in
/// the config -- an id would be a thing to go and look up.
pub fn project_issues_query(project: &str) -> Value {
    json!({
        "query": "query IssuesInProject($project: String!) { \
                  issues(filter: { project: { name: { eq: $project } } }, first: 100) { \
                  nodes { id identifier title state { name type } \
                  assignee { name } updatedAt } } }",
        "variables": { "project": project },
    })
}

/// Verify a credential, and say whose it is.
///
/// Generic over the trait so this whole path is provable with a fake: the only
/// thing a real client adds is the socket.
pub fn verify_linear_token(api: &impl LinearApi, token: &str) -> LinearCall<String> {
    let response = match api.post_graphql(token, &viewer_query()) {
        Ok((status, body)) => parse_graphql_response(status, &body),
        // A transport failure is NOT an empty answer, and the reason is
        // carried rather than flattened to "failed".
        Err(reason) => return LinearCall::Unreachable(reason),
    };
    match response {
        LinearCall::Ok(data) => {
            let name = data
                .get("viewer")
                .and_then(|viewer| viewer.get("name"))
                .and_then(Value::as_str);
            match name {
                Some(name) => LinearCall::Ok(name.to_owned()),
                // Answered, but not with the shape we asked for. Saying this
                // rather than returning an empty name keeps a protocol change
                // from reading as an anonymous user.
                None => LinearCall::Rejected(vec![
                    "Linear answered the viewer query without a name".to_owned(),
                ]),
            }
        }
        // Every other variant carries no viewer, so it maps across unchanged.
        LinearCall::Unauthorized => LinearCall::Unauthorized,
        LinearCall::RateLimited { retry_after_secs } => {
            LinearCall::RateLimited { retry_after_secs }
        }
        LinearCall::ServerError { status } => LinearCall::ServerError { status },
        LinearCall::Rejected(errors) => LinearCall::Rejected(errors),
        LinearCall::Unreachable(reason) => LinearCall::Unreachable(reason),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Records what it was asked to send, so a test can assert on the request
    /// as well as on the answer.
    struct FakeApi {
        answer: Result<(u16, Value), String>,
        seen: RefCell<Vec<(String, Value)>>,
    }

    impl FakeApi {
        fn answering(status: u16, body: Value) -> Self {
            Self {
                answer: Ok((status, body)),
                seen: RefCell::new(Vec::new()),
            }
        }
        fn failing(reason: &str) -> Self {
            Self {
                answer: Err(reason.to_owned()),
                seen: RefCell::new(Vec::new()),
            }
        }
    }

    impl LinearApi for FakeApi {
        fn post_graphql(&self, token: &str, body: &Value) -> Result<(u16, Value), String> {
            self.seen
                .borrow_mut()
                .push((token.to_owned(), body.clone()));
            self.answer.clone()
        }
    }

    /// THE GATE THIS MODULE EXISTS FOR. GraphQL reports query errors with HTTP
    /// 200, so a parser keyed on the status alone calls a failed query a
    /// success and hands back whatever `data` happens to hold.
    #[test]
    fn a_two_hundred_carrying_errors_is_a_failure_not_a_success() {
        let body = json!({
            "data": null,
            "errors": [{ "message": "Entity not found: Project" }],
        });
        assert_eq!(
            parse_graphql_response(200, &body),
            LinearCall::Rejected(vec!["Entity not found: Project".to_owned()])
        );
    }

    /// And a 200 with errors AND usable data is still a failure. Linear can
    /// answer a partially-resolved query that way, and taking the data would
    /// silently act on half an answer.
    #[test]
    fn errors_beat_data_when_both_are_present() {
        let body = json!({
            "data": { "issues": { "nodes": [] } },
            "errors": [{ "message": "field was throttled" }],
        });
        assert!(matches!(
            parse_graphql_response(200, &body),
            LinearCall::Rejected(_)
        ));
    }

    /// A project with no issues SUCCEEDED. This is the distinction AGENTS.md
    /// turns on: nothing-found and could-not-ask are different answers, and
    /// this one is a true empty.
    #[test]
    fn an_empty_result_set_is_a_success_not_a_failure() {
        let body = json!({ "data": { "issues": { "nodes": [] } } });
        let call = parse_graphql_response(200, &body);
        assert_eq!(call, LinearCall::Ok(json!({ "issues": { "nodes": [] } })));
        assert_eq!(call.failure_line(), None, "an empty result named a failure");
    }

    /// Neither data nor errors is MALFORMED, not empty. Returning an empty
    /// value here would invent an account with no work in it.
    #[test]
    fn neither_data_nor_errors_is_rejected_rather_than_empty() {
        assert!(matches!(
            parse_graphql_response(200, &json!({})),
            LinearCall::Rejected(_)
        ));
        assert!(matches!(
            parse_graphql_response(200, &json!({ "data": null })),
            LinearCall::Rejected(_)
        ));
        // An empty errors array is not an error either -- it is still the
        // malformed case, and must not read as Ok.
        assert!(matches!(
            parse_graphql_response(200, &json!({ "errors": [] })),
            LinearCall::Rejected(_)
        ));
    }

    #[test]
    fn the_status_codes_a_caller_treats_differently_stay_apart() {
        assert_eq!(
            parse_graphql_response(401, &json!({})),
            LinearCall::Unauthorized
        );
        assert_eq!(
            parse_graphql_response(403, &json!({})),
            LinearCall::Unauthorized
        );
        assert_eq!(
            parse_graphql_response(429, &json!({ "retryAfter": 30 })),
            LinearCall::RateLimited {
                retry_after_secs: Some(30)
            }
        );
        assert_eq!(
            parse_graphql_response(429, &json!({})),
            LinearCall::RateLimited {
                retry_after_secs: None
            }
        );
        assert_eq!(
            parse_graphql_response(503, &json!({})),
            LinearCall::ServerError { status: 503 }
        );
    }

    /// An auth failure can arrive as a GraphQL error with a 401 rather than a
    /// bare status, and calling that "a bug in our query" would send somebody
    /// to rewrite a query when the token is the problem.
    #[test]
    fn an_unauthorized_status_wins_over_its_graphql_errors() {
        let body = json!({ "errors": [{ "message": "Authentication required" }] });
        assert_eq!(parse_graphql_response(401, &body), LinearCall::Unauthorized);
    }

    #[test]
    fn a_graphql_error_without_a_message_still_says_something() {
        let body = json!({ "errors": [{ "extensions": { "code": "x" } }] });
        assert_eq!(
            parse_graphql_response(200, &body),
            LinearCall::Rejected(vec!["an error with no message".to_owned()])
        );
    }

    #[test]
    fn verifying_a_token_names_the_person_it_belongs_to() {
        let api = FakeApi::answering(
            200,
            json!({ "data": { "viewer": { "id": "u1", "name": "Sam S." } } }),
        );
        assert_eq!(
            verify_linear_token(&api, "lin_api_secret"),
            LinearCall::Ok("Sam S.".to_owned())
        );
        // The token reached the client, and ONLY through the token argument.
        let seen = api.seen.borrow();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, "lin_api_secret");
        let sent = seen[0].1.to_string();
        assert!(
            !sent.contains("lin_api_secret"),
            "the token was baked into the request body: {sent}"
        );
    }

    /// A TRANSPORT FAILURE IS NOT AN EMPTY ANSWER, and its reason survives.
    /// Flattening this is how "no Linear account" and "the wifi is down"
    /// become the same sentence.
    #[test]
    fn an_unreachable_api_keeps_its_reason() {
        let api = FakeApi::failing("dns error: no such host");
        let call = verify_linear_token(&api, "t");
        assert_eq!(
            call,
            LinearCall::Unreachable("dns error: no such host".to_owned())
        );
        let line = call
            .failure_line()
            .expect("unreachable must explain itself");
        assert!(line.contains("dns error: no such host"), "{line}");
    }

    /// Answered, but not with the shape we asked for. An empty name here would
    /// read as an anonymous user rather than a protocol change.
    #[test]
    fn a_viewer_without_a_name_is_rejected_not_anonymous() {
        let api = FakeApi::answering(200, json!({ "data": { "viewer": { "id": "u1" } } }));
        assert!(matches!(
            verify_linear_token(&api, "t"),
            LinearCall::Rejected(_)
        ));
    }

    /// Every failure variant has to survive the hop through
    /// `verify_linear_token` rather than becoming a generic error, because the
    /// whole point of the enum is that a caller can tell them apart.
    #[test]
    fn verification_preserves_which_failure_it_was() {
        let unauthorized = FakeApi::answering(401, json!({}));
        assert_eq!(
            verify_linear_token(&unauthorized, "t"),
            LinearCall::Unauthorized
        );

        let limited = FakeApi::answering(429, json!({ "retryAfter": 5 }));
        assert_eq!(
            verify_linear_token(&limited, "t"),
            LinearCall::RateLimited {
                retry_after_secs: Some(5)
            }
        );

        let unwell = FakeApi::answering(502, json!({}));
        assert_eq!(
            verify_linear_token(&unwell, "t"),
            LinearCall::ServerError { status: 502 }
        );
    }

    /// Every failure says something, and `Ok` says nothing. A silent failure
    /// is the one a surface renders as a blank.
    #[test]
    fn every_failure_explains_itself_and_success_does_not() {
        assert_eq!(LinearCall::Ok(json!(1)).failure_line(), None);
        for failure in [
            LinearCall::<Value>::Unauthorized,
            LinearCall::RateLimited {
                retry_after_secs: Some(7),
            },
            LinearCall::RateLimited {
                retry_after_secs: None,
            },
            LinearCall::ServerError { status: 500 },
            LinearCall::Rejected(vec!["bad field".to_owned()]),
            LinearCall::Unreachable("timed out".to_owned()),
        ] {
            let line = failure
                .failure_line()
                .unwrap_or_else(|| panic!("{failure:?} explained nothing"));
            assert!(!line.is_empty(), "{failure:?} explained itself with ''");
        }
    }

    /// The project filter has to carry the name as a VARIABLE. Interpolating it
    /// into the query string is both an injection and a quoting bug waiting for
    /// a project with an apostrophe in it.
    #[test]
    fn the_project_name_travels_as_a_variable_not_in_the_query() {
        let query = project_issues_query("Aimux \"Core\"");
        assert_eq!(query["variables"]["project"], json!("Aimux \"Core\""));
        let text = query["query"].as_str().expect("a query string");
        assert!(
            !text.contains("Aimux"),
            "the project name was interpolated into the query: {text}"
        );
        assert!(text.contains("$project: String!"), "{text}");
    }

    #[test]
    fn the_viewer_query_asks_for_a_name() {
        let text = viewer_query()["query"]
            .as_str()
            .expect("a query")
            .to_owned();
        assert!(text.contains("viewer"), "{text}");
        assert!(text.contains("name"), "{text}");
    }
}
