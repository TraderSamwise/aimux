use serde_json::{Map, Value, json};

const REVIEW_DIFF: &str = "diff --git a/file.txt b/file.txt\nindex 90be1f3..eecca90 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1,2 @@\n before\n+after\n";

pub fn run_dashboard_interaction_review_request_contract_case(input: &Value) -> Value {
    let mut state = ReviewRequestState::new(input);
    state.handle_review_request();
    state.summary()
}

struct ReviewRequestState {
    active_session: Value,
    session_roles: Value,
    session_worktree_paths: Value,
    team_config: Value,
    make_diff: bool,
    returned_assignee: Option<String>,
    post_throws: Option<String>,
    footer_flash: Value,
    footer_flash_ticks: i64,
    calls: Vec<Value>,
}

impl ReviewRequestState {
    fn new(input: &Value) -> Self {
        Self {
            active_session: input.get("activeSession").cloned().unwrap_or(Value::Null),
            session_roles: input
                .get("sessionRoles")
                .cloned()
                .unwrap_or_else(|| json!({})),
            session_worktree_paths: input
                .get("sessionWorktreePaths")
                .cloned()
                .unwrap_or_else(|| json!({})),
            team_config: input
                .get("teamConfig")
                .cloned()
                .unwrap_or_else(default_team_config),
            make_diff: input
                .get("makeDiff")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            returned_assignee: input
                .get("returnedAssignee")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            post_throws: input
                .get("postThrows")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            footer_flash: Value::Null,
            footer_flash_ticks: 0,
            calls: Vec::new(),
        }
    }

    fn summary(&self) -> Value {
        json!({
            "footerFlash": self.footer_flash,
            "footerFlashTicks": self.footer_flash_ticks,
            "calls": self.calls,
        })
    }

    fn handle_review_request(&mut self) {
        if self.active_session.is_null() {
            return;
        }
        let session_id = string_field(&self.active_session, "id");
        let command = string_field(&self.active_session, "command");
        let role = self
            .session_roles
            .get(&session_id)
            .and_then(Value::as_str)
            .unwrap_or("coder")
            .to_owned();
        let Some(reviewer_role) = self.resolve_reviewer_role(&role) else {
            self.footer_flash = json!("No reviewer role configured");
            self.footer_flash_ticks = 3;
            self.call("renderDashboard", vec![]);
            return;
        };

        let worktree_path = self.session_worktree_paths.get(&session_id).cloned();
        let mut payload = Map::new();
        payload.insert("from".to_owned(), json!(session_id));
        payload.insert("assignee".to_owned(), json!(reviewer_role));
        payload.insert(
            "description".to_owned(),
            json!(format!("Review: Review {command} agent's recent work")),
        );
        payload.insert(
            "prompt".to_owned(),
            json!(format!("Review {command} agent's recent work")),
        );
        payload.insert("type".to_owned(), json!("review"));
        if self.make_diff {
            payload.insert("diff".to_owned(), json!(REVIEW_DIFF));
        }
        if let Some(worktree_path) = worktree_path {
            payload.insert("worktreePath".to_owned(), worktree_path);
        }
        payload.insert("assigner".to_owned(), json!(role));
        payload.insert(
            "reviewOf".to_owned(),
            json!(string_field(&self.active_session, "id")),
        );
        payload.insert("iteration".to_owned(), json!(1));
        self.call(
            "postToProjectService",
            vec![json!("/tasks/assign"), Value::Object(payload)],
        );

        if let Some(error) = self.post_throws.clone() {
            self.call(
                "showDashboardError",
                vec![json!("Failed to request review"), json!([error])],
            );
            self.call("renderDashboard", vec![]);
            return;
        }

        let assignee = self.returned_assignee.clone().unwrap_or(reviewer_role);
        self.footer_flash = json!(format!("\u{29eb} Review requested \u{2192} {assignee}"));
        self.footer_flash_ticks = 3;
        self.call("renderDashboard", vec![]);
    }

    fn resolve_reviewer_role(&self, role: &str) -> Option<String> {
        let roles = self.team_config.get("roles")?.as_object()?;
        let reviewed_by = roles
            .get(role)
            .and_then(|role_config| role_config.get("reviewedBy"))
            .and_then(Value::as_str)
            .filter(|reviewed_by| *reviewed_by != role)
            .map(ToOwned::to_owned);
        if reviewed_by.is_some() {
            return reviewed_by;
        }
        for (role_key, config) in roles {
            if role_key == role {
                continue;
            }
            if config
                .get("description")
                .and_then(Value::as_str)
                .is_some_and(|description| description.to_lowercase().contains("review"))
            {
                return Some(role_key.clone());
            }
        }
        for (role_key, config) in roles {
            if role_key == role {
                continue;
            }
            if config.get("canEdit").and_then(Value::as_bool) == Some(true) {
                return Some(role_key.clone());
            }
        }
        None
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }
}

fn default_team_config() -> Value {
    json!({
        "roles": {
            "coder": {
                "description": "Implements features and fixes bugs",
                "reviewedBy": "reviewer",
            },
            "reviewer": {
                "description": "Reviews code changes, approves or requests changes",
                "canEdit": true,
            },
        },
        "defaultRole": "coder",
    })
}

fn string_field(input: &Value, key: &str) -> String {
    input
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
