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

/// Where a new issue goes: Linear needs ids, the config has a name.
///
/// `issueCreate` requires a `teamId`, and a project name is not one, so a
/// create is always two calls: resolve, then write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectTarget {
    pub project_id: String,
    pub team_id: String,
}

/// What resolving a project name found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectLookup {
    Found(ProjectTarget),
    /// No project by that name. A real answer, and a config to fix.
    NotFound,
    /// SEVERAL projects share the name, so we cannot tell which was meant.
    ///
    /// Linear allows this across teams, and picking the first would file work
    /// into whichever project the API happened to list first -- a confident
    /// wrong answer, and the kind that is only noticed when somebody goes
    /// looking for a task that is in the wrong place.
    Ambiguous {
        count: usize,
    },
    /// A project with no team. Cannot be written to, because `issueCreate`
    /// needs the team id.
    NoTeam,
}

/// The ids behind a project name.
pub fn project_lookup_query(project: &str) -> Value {
    json!({
        "query": "query ProjectTarget($project: String!) { \
                  projects(filter: { name: { eq: $project } }, first: 10) { \
                  nodes { id name teams(first: 2) { nodes { id } } } } }",
        "variables": { "project": project },
    })
}

/// Read a project lookup.
pub fn parse_project_lookup(data: &Value) -> ProjectLookup {
    let nodes = data
        .get("projects")
        .and_then(|projects| projects.get("nodes"))
        .and_then(Value::as_array);
    let Some(nodes) = nodes else {
        return ProjectLookup::NotFound;
    };
    match nodes.len() {
        0 => ProjectLookup::NotFound,
        1 => {
            let node = &nodes[0];
            let Some(project_id) = node.get("id").and_then(Value::as_str) else {
                return ProjectLookup::NotFound;
            };
            let team_id = node
                .get("teams")
                .and_then(|teams| teams.get("nodes"))
                .and_then(Value::as_array)
                .and_then(|teams| teams.first())
                .and_then(|team| team.get("id"))
                .and_then(Value::as_str);
            match team_id {
                Some(team_id) => ProjectLookup::Found(ProjectTarget {
                    project_id: project_id.to_owned(),
                    team_id: team_id.to_owned(),
                }),
                None => ProjectLookup::NoTeam,
            }
        }
        // Two or more. Refused rather than guessed -- see `Ambiguous`.
        count => ProjectLookup::Ambiguous { count },
    }
}

/// Create an issue in a resolved project.
///
/// Every value travels as a VARIABLE, never interpolated: a title is arbitrary
/// user text and the first one containing a quote would both break the query
/// and give somebody a way to write their own.
pub fn issue_create_mutation(target: &ProjectTarget, title: &str, description: &str) -> Value {
    json!({
        "query": "mutation CreateIssue($teamId: String!, $projectId: String!, \
                  $title: String!, $description: String!) { \
                  issueCreate(input: { teamId: $teamId, projectId: $projectId, \
                  title: $title, description: $description }) { \
                  success issue { id identifier title url } } }",
        "variables": {
            "teamId": target.team_id,
            "projectId": target.project_id,
            "title": title,
            "description": description,
        },
    })
}

/// What Linear made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedIssue {
    pub id: String,
    pub identifier: String,
    pub url: Option<String>,
}

/// Read a create response.
///
/// `success: false` with no errors is Linear's way of refusing a mutation it
/// understood, so it is checked explicitly -- a parser that only looked for
/// the issue would report a creation that never happened.
pub fn parse_created_issue(data: &Value) -> Result<CreatedIssue, String> {
    let create = data
        .get("issueCreate")
        .ok_or_else(|| "Linear's answer carried no issueCreate result".to_owned())?;
    if create.get("success").and_then(Value::as_bool) != Some(true) {
        return Err("Linear refused to create the issue".to_owned());
    }
    let issue = create
        .get("issue")
        .ok_or_else(|| "Linear reported success but returned no issue".to_owned())?;
    let id = issue
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Linear created an issue with no id".to_owned())?;
    let identifier = issue
        .get("identifier")
        .and_then(Value::as_str)
        // The human key is what a person needs to go and look; without it the
        // creation is real but unfindable, which is worth saying.
        .ok_or_else(|| "Linear created an issue with no identifier".to_owned())?;
    Ok(CreatedIssue {
        id: id.to_owned(),
        identifier: identifier.to_owned(),
        url: issue.get("url").and_then(Value::as_str).map(str::to_owned),
    })
}

/// Split a Linear issue key into the team key and the number.
///
/// Linear's GraphQL has no "filter by identifier", so `AIM-12` has to become a
/// team key plus a number to be looked up at all. Doing it here makes the
/// parsing provable instead of buried in a query builder.
///
/// `None` for anything that is not an identifier, rather than a guess: looking
/// up the wrong issue and moving it is worse than refusing a typo.
pub fn split_issue_identifier(identifier: &str) -> Option<(String, u64)> {
    let trimmed = identifier.trim();
    // `rsplit_once` because a team key may itself contain a hyphen, and the
    // NUMBER is always last.
    let (team, number) = trimmed.rsplit_once('-')?;
    if team.is_empty() {
        return None;
    }
    // Rejected rather than truncated: `AIM-12x` is not issue 12.
    let number: u64 = number.parse().ok()?;
    Some((team.to_owned(), number))
}

/// Find one issue by its team key and number.
pub fn issue_lookup_query(team: &str, number: u64) -> Value {
    json!({
        "query": "query FindIssue($team: String!, $number: Float!) { \
                  issues(filter: { team: { key: { eq: $team } }, \
                  number: { eq: $number } }, first: 2) { \
                  nodes { id identifier team { id } } } }",
        "variables": { "team": team, "number": number },
    })
}

/// What an issue lookup found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IssueLookup {
    Found {
        issue_id: String,
        team_id: String,
    },
    NotFound,
    /// Two issues matched one team key and number, which should be impossible.
    /// Refused rather than resolved, because moving the wrong issue is the one
    /// outcome that cannot be undone by retrying.
    Ambiguous,
    /// Found, but with no team, so its workflow states cannot be read.
    NoTeam,
}

pub fn parse_issue_lookup(data: &Value) -> IssueLookup {
    let nodes = data
        .get("issues")
        .and_then(|issues| issues.get("nodes"))
        .and_then(Value::as_array);
    let Some(nodes) = nodes else {
        return IssueLookup::NotFound;
    };
    match nodes.len() {
        0 => IssueLookup::NotFound,
        1 => {
            let node = &nodes[0];
            let Some(issue_id) = node.get("id").and_then(Value::as_str) else {
                return IssueLookup::NotFound;
            };
            match node
                .get("team")
                .and_then(|team| team.get("id"))
                .and_then(Value::as_str)
            {
                Some(team_id) => IssueLookup::Found {
                    issue_id: issue_id.to_owned(),
                    team_id: team_id.to_owned(),
                },
                None => IssueLookup::NoTeam,
            }
        }
        _ => IssueLookup::Ambiguous,
    }
}

/// A team's workflow states, which is where a state id comes from.
pub fn workflow_states_query(team_id: &str) -> Value {
    json!({
        "query": "query TeamStates($teamId: String!) { \
                  team(id: $teamId) { states(first: 50) { \
                  nodes { id name type position } } } }",
        "variables": { "teamId": team_id },
    })
}

/// Find the state id to move an issue into, for one Linear state TYPE.
///
/// Keyed on type for the same reason `local_status_for_linear_state` reads it:
/// a workspace renames columns freely and the type does not move. When a team
/// has SEVERAL states of one type -- several `started` columns is normal -- the
/// lowest `position` wins, which is the leftmost column and the one a person
/// would call "the" in-progress state.
///
/// `None` means the team genuinely has no state of that type, which is a real
/// answer about the team's workflow rather than a failure to look.
pub fn state_id_for_type(data: &Value, state_type: &str) -> Option<String> {
    let nodes = data
        .get("team")
        .and_then(|team| team.get("states"))
        .and_then(|states| states.get("nodes"))
        .and_then(Value::as_array)?;
    let mut best: Option<(f64, &str)> = None;
    for node in nodes {
        if node.get("type").and_then(Value::as_str) != Some(state_type) {
            continue;
        }
        let Some(id) = node.get("id").and_then(Value::as_str) else {
            continue;
        };
        // A state with no position sorts last rather than first, so a
        // missing field cannot win over a real leftmost column.
        let position = node
            .get("position")
            .and_then(Value::as_f64)
            .unwrap_or(f64::MAX);
        if best.is_none_or(|(known, _)| position < known) {
            best = Some((position, id));
        }
    }
    best.map(|(_, id)| id.to_owned())
}

/// Move an issue into a state.
pub fn issue_update_state_mutation(issue_id: &str, state_id: &str) -> Value {
    json!({
        "query": "mutation MoveIssue($id: String!, $stateId: String!) { \
                  issueUpdate(id: $id, input: { stateId: $stateId }) { \
                  success issue { id identifier state { name type } } } }",
        "variables": { "id": issue_id, "stateId": state_id },
    })
}

/// Read an update response.
///
/// `success: false` is checked explicitly for the same reason it is on create:
/// it is how Linear refuses a mutation it understood, and a parser that only
/// looked at the issue would report a move that never happened.
pub fn parse_updated_issue(data: &Value) -> Result<String, String> {
    let update = data
        .get("issueUpdate")
        .ok_or_else(|| "Linear's answer carried no issueUpdate result".to_owned())?;
    if update.get("success").and_then(Value::as_bool) != Some(true) {
        return Err("Linear refused to move the issue".to_owned());
    }
    let issue = update
        .get("issue")
        .ok_or_else(|| "Linear reported success but returned no issue".to_owned())?;
    // The state it ENDED in, read back rather than assumed, so the report says
    // what Linear did and not what we asked for.
    let state = issue
        .get("state")
        .and_then(|state| state.get("name"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Linear moved the issue but did not say to which state".to_owned())?;
    Ok(state.to_owned())
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

    fn target() -> ProjectTarget {
        ProjectTarget {
            project_id: "proj-1".to_owned(),
            team_id: "team-1".to_owned(),
        }
    }

    #[test]
    fn one_project_resolves_to_its_project_and_team_ids() {
        let data = json!({ "projects": { "nodes": [
            { "id": "proj-1", "name": "Aimux", "teams": { "nodes": [{ "id": "team-1" }] } }
        ]}});
        assert_eq!(parse_project_lookup(&data), ProjectLookup::Found(target()));
    }

    /// THE GATE THAT MATTERS MOST ON THE WRITE PATH. Linear allows two
    /// projects to share a name across teams, and taking the first would file
    /// work into whichever the API happened to list first -- only noticed when
    /// somebody goes looking for a task that is in the wrong project.
    #[test]
    fn two_projects_sharing_a_name_are_refused_rather_than_guessed() {
        let data = json!({ "projects": { "nodes": [
            { "id": "a", "name": "Aimux", "teams": { "nodes": [{ "id": "team-1" }] } },
            { "id": "b", "name": "Aimux", "teams": { "nodes": [{ "id": "team-2" }] } }
        ]}});
        assert_eq!(
            parse_project_lookup(&data),
            ProjectLookup::Ambiguous { count: 2 }
        );
    }

    /// No project and no projects key are both "not found" -- a real answer
    /// about a config to fix.
    #[test]
    fn a_missing_project_is_not_found() {
        assert_eq!(
            parse_project_lookup(&json!({ "projects": { "nodes": [] } })),
            ProjectLookup::NotFound
        );
        assert_eq!(parse_project_lookup(&json!({})), ProjectLookup::NotFound);
    }

    /// A project with no team cannot be written to, because `issueCreate`
    /// needs the team id. Said rather than reported as "not found", which
    /// would send somebody to check a name that is perfectly correct.
    #[test]
    fn a_project_with_no_team_says_so_rather_than_not_found() {
        let data = json!({ "projects": { "nodes": [
            { "id": "proj-1", "name": "Aimux", "teams": { "nodes": [] } }
        ]}});
        assert_eq!(parse_project_lookup(&data), ProjectLookup::NoTeam);
    }

    /// Arbitrary user text in a title must travel as a VARIABLE. The first
    /// title with a quote in it would otherwise break the query and hand
    /// somebody a way to write their own.
    #[test]
    fn the_title_and_description_travel_as_variables() {
        let mutation = issue_create_mutation(
            &target(),
            "Fix the \"quoted\" thing",
            "A description with } braces { too",
        );
        assert_eq!(
            mutation["variables"]["title"],
            json!("Fix the \"quoted\" thing")
        );
        assert_eq!(
            mutation["variables"]["description"],
            json!("A description with } braces { too")
        );
        let text = mutation["query"].as_str().expect("a query");
        assert!(
            !text.contains("quoted"),
            "the title was interpolated into the query: {text}"
        );
        assert!(text.contains("$title: String!"), "{text}");
        // The ids too, for the same reason.
        assert_eq!(mutation["variables"]["teamId"], json!("team-1"));
        assert_eq!(mutation["variables"]["projectId"], json!("proj-1"));
    }

    #[test]
    fn a_created_issue_carries_the_key_a_person_needs() {
        let data = json!({ "issueCreate": {
            "success": true,
            "issue": {
                "id": "uuid-1",
                "identifier": "AIM-20",
                "title": "x",
                "url": "https://linear.app/t/issue/AIM-20",
            }
        }});
        assert_eq!(
            parse_created_issue(&data),
            Ok(CreatedIssue {
                id: "uuid-1".to_owned(),
                identifier: "AIM-20".to_owned(),
                url: Some("https://linear.app/t/issue/AIM-20".to_owned()),
            })
        );
    }

    /// `success: false` WITH NO ERRORS is how Linear refuses a mutation it
    /// understood. A parser that only looked for the issue would report a
    /// creation that never happened.
    #[test]
    fn a_refused_mutation_is_not_a_creation() {
        // A FULLY POPULATED ISSUE BESIDE `success: false`, which is the case
        // that actually proves the check. My first version paired the refusal
        // with `issue: null`, so dropping the success check still errored --
        // on the missing id, for the wrong reason. The mutation passed and
        // told me the gate was decorative.
        let refused = json!({ "issueCreate": {
            "success": false,
            "issue": { "id": "uuid-1", "identifier": "AIM-99", "url": "https://x" }
        }});
        let error = parse_created_issue(&refused).expect_err("a refusal is not a creation");
        assert!(
            error.contains("refused"),
            "a refusal with a populated issue read as a creation: {error}"
        );

        // And the null-issue refusal, which must also fail.
        let refused_empty = json!({ "issueCreate": { "success": false, "issue": null } });
        assert!(parse_created_issue(&refused_empty).is_err());

        // Success with no issue is also not a creation -- it is a protocol
        // change, and reporting it as made would promise something absent.
        let hollow = json!({ "issueCreate": { "success": true } });
        let error = parse_created_issue(&hollow).expect_err("no issue is an error");
        assert!(error.contains("no issue"), "{error}");

        // And no result at all.
        assert!(parse_created_issue(&json!({})).is_err());
    }

    /// An issue with no identifier IS created but cannot be found again, which
    /// is worth saying rather than returning a blank key.
    #[test]
    fn a_created_issue_with_no_identifier_is_reported_not_blanked() {
        let data = json!({ "issueCreate": {
            "success": true,
            "issue": { "id": "uuid-1" }
        }});
        let error = parse_created_issue(&data).expect_err("no identifier is an error");
        assert!(error.contains("identifier"), "{error}");
    }

    /// A URL is nice and absent is fine -- unlike the identifier, nothing
    /// depends on it.
    #[test]
    fn a_created_issue_without_a_url_is_still_a_creation() {
        let data = json!({ "issueCreate": {
            "success": true,
            "issue": { "id": "uuid-1", "identifier": "AIM-21" }
        }});
        let created = parse_created_issue(&data).expect("still created");
        assert_eq!(created.url, None);
        assert_eq!(created.identifier, "AIM-21");
    }

    /// `rsplit_once` because a team key may contain a hyphen and the NUMBER is
    /// always last. `AIM-CORE-12` is issue 12 of team `AIM-CORE`.
    #[test]
    fn an_identifier_splits_into_a_team_key_and_a_number() {
        assert_eq!(
            split_issue_identifier("AIM-12"),
            Some(("AIM".to_owned(), 12))
        );
        assert_eq!(
            split_issue_identifier("  AIM-12  "),
            Some(("AIM".to_owned(), 12))
        );
        assert_eq!(
            split_issue_identifier("AIM-CORE-12"),
            Some(("AIM-CORE".to_owned(), 12))
        );
    }

    /// A TYPO IS REFUSED, NOT GUESSED, because looking up the wrong issue and
    /// MOVING it is the one outcome retrying cannot undo. `AIM-12x` is not
    /// issue 12.
    #[test]
    fn a_malformed_identifier_is_refused_rather_than_coerced() {
        for bad in ["AIM", "AIM-", "-12", "AIM-12x", "AIM-x", "", "12"] {
            assert_eq!(
                split_issue_identifier(bad),
                None,
                "{bad:?} was coerced into an identifier"
            );
        }
    }

    #[test]
    fn one_issue_resolves_to_its_issue_and_team_ids() {
        let data = json!({ "issues": { "nodes": [
            { "id": "issue-1", "identifier": "AIM-12", "team": { "id": "team-1" } }
        ]}});
        assert_eq!(
            parse_issue_lookup(&data),
            IssueLookup::Found {
                issue_id: "issue-1".to_owned(),
                team_id: "team-1".to_owned(),
            }
        );
    }

    /// Two matches for one team key and number should be impossible, so it is
    /// REFUSED rather than resolved -- moving the wrong issue cannot be undone
    /// by retrying.
    #[test]
    fn two_matching_issues_are_refused_rather_than_resolved() {
        let data = json!({ "issues": { "nodes": [
            { "id": "a", "team": { "id": "t" } },
            { "id": "b", "team": { "id": "t" } }
        ]}});
        assert_eq!(parse_issue_lookup(&data), IssueLookup::Ambiguous);
    }

    #[test]
    fn a_missing_issue_is_not_found_and_a_teamless_one_says_so() {
        assert_eq!(
            parse_issue_lookup(&json!({ "issues": { "nodes": [] } })),
            IssueLookup::NotFound
        );
        assert_eq!(parse_issue_lookup(&json!({})), IssueLookup::NotFound);
        let no_team = json!({ "issues": { "nodes": [{ "id": "issue-1" }] } });
        assert_eq!(parse_issue_lookup(&no_team), IssueLookup::NoTeam);
    }

    /// SEVERAL STATES OF ONE TYPE IS NORMAL -- a team can have two `started`
    /// columns -- so the lowest `position` wins, which is the leftmost column
    /// and the one a person means by "the" in-progress state. Picking
    /// whichever the API listed first would move issues into a different
    /// column depending on the response order.
    #[test]
    fn the_leftmost_state_of_a_type_wins() {
        let data = json!({ "team": { "states": { "nodes": [
            { "id": "late", "name": "In Review", "type": "started", "position": 3.0 },
            { "id": "early", "name": "In Progress", "type": "started", "position": 1.0 },
            { "id": "done", "name": "Done", "type": "completed", "position": 4.0 }
        ]}}});
        assert_eq!(
            state_id_for_type(&data, "started"),
            Some("early".to_owned())
        );
        assert_eq!(
            state_id_for_type(&data, "completed"),
            Some("done".to_owned())
        );
    }

    /// A state with no position must sort LAST, not first -- otherwise a
    /// missing field beats a real leftmost column.
    #[test]
    fn a_state_with_no_position_does_not_win() {
        let data = json!({ "team": { "states": { "nodes": [
            { "id": "unpositioned", "type": "started" },
            { "id": "real", "type": "started", "position": 2.0 }
        ]}}});
        assert_eq!(state_id_for_type(&data, "started"), Some("real".to_owned()));
    }

    /// No state of that type is a REAL answer about the team's workflow, not a
    /// failure to look -- some teams have no `canceled` column at all.
    #[test]
    fn a_type_the_team_does_not_have_is_absent_rather_than_wrong() {
        let data = json!({ "team": { "states": { "nodes": [
            { "id": "a", "type": "started", "position": 1.0 }
        ]}}});
        assert_eq!(state_id_for_type(&data, "canceled"), None);
        // And no states at all, which must not panic or invent one.
        assert_eq!(state_id_for_type(&json!({}), "started"), None);
    }

    /// The state Linear ENDED in is read back, so a report says what Linear
    /// did rather than what we asked for.
    #[test]
    fn a_moved_issue_reports_the_state_it_actually_landed_in() {
        let data = json!({ "issueUpdate": {
            "success": true,
            "issue": { "id": "i", "identifier": "AIM-12",
                       "state": { "name": "In Review", "type": "started" } }
        }});
        assert_eq!(parse_updated_issue(&data), Ok("In Review".to_owned()));
    }

    /// `success: false` WITH A POPULATED ISSUE, which is the fixture that
    /// actually proves the check -- pairing a refusal with a null issue lets
    /// the parser fail for the wrong reason and the gate proves nothing. Same
    /// lesson as the create path.
    #[test]
    fn a_refused_move_is_not_a_move() {
        let refused = json!({ "issueUpdate": {
            "success": false,
            "issue": { "id": "i", "identifier": "AIM-12",
                       "state": { "name": "Todo", "type": "unstarted" } }
        }});
        let error = parse_updated_issue(&refused).expect_err("a refusal is not a move");
        assert!(
            error.contains("refused"),
            "a refusal with a populated issue read as a move: {error}"
        );

        assert!(parse_updated_issue(&json!({})).is_err());
        let hollow = json!({ "issueUpdate": { "success": true } });
        assert!(parse_updated_issue(&hollow).is_err());
    }

    /// Both ids travel as variables, like every other value we send.
    #[test]
    fn the_move_sends_its_ids_as_variables() {
        let mutation = issue_update_state_mutation("issue-1", "state-1");
        assert_eq!(mutation["variables"]["id"], json!("issue-1"));
        assert_eq!(mutation["variables"]["stateId"], json!("state-1"));
        let text = mutation["query"].as_str().expect("a query");
        assert!(!text.contains("issue-1"), "{text}");
        assert!(text.contains("$stateId: String!"), "{text}");
    }

    /// The lookup's team key is a variable too -- a team key is workspace data
    /// and could contain anything.
    #[test]
    fn the_issue_lookup_sends_its_team_key_as_a_variable() {
        let query = issue_lookup_query("AIM\"X", 12);
        assert_eq!(query["variables"]["team"], json!("AIM\"X"));
        assert_eq!(query["variables"]["number"], json!(12));
        let text = query["query"].as_str().expect("a query");
        assert!(
            !text.contains("AIM"),
            "the team key was interpolated: {text}"
        );
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
