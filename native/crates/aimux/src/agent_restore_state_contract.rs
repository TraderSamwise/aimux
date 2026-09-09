use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

const WRITER: &str = "<writer-instance>";

#[derive(Default)]
struct RestoreState {
    snapshot: Option<Value>,
    offer: Option<Value>,
    gate: Option<Value>,
    ack_snapshot_id: Option<String>,
    next_online_id: usize,
}

pub fn agent_restore_state_contract(input: &Value) -> Value {
    let mut state = RestoreState::default();
    let mut events = Vec::new();
    for step in input
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let result = state.apply(step);
        events.push(json!({
            "step": step,
            "result": result,
        }));
    }
    normalize_contract_value(Value::Array(events))
}

impl RestoreState {
    fn apply(&mut self, step: &Value) -> Value {
        match string_field(step, "op").as_deref() {
            Some("record") => self.record(
                step.get("sessions")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                string_field(step, "now").unwrap_or_else(|| "<updatedAt>".into()),
            ),
            Some("readSnapshot") => self.snapshot.clone().unwrap_or(Value::Null),
            Some("removeSnapshotSessions") => self.remove_snapshot_sessions(
                string_array(step.get("sessionIds")),
                string_field(step, "now").unwrap_or_else(|| "<updatedAt>".into()),
            ),
            Some("writeFile") => {
                self.write_file(
                    string_field(step, "file").unwrap_or_default().as_str(),
                    step.get("body").cloned().unwrap_or(Value::Null),
                );
                Value::String("written".into())
            }
            Some("rewriteSnapshotWriter") => {
                if let Some(snapshot) = self.snapshot.as_mut().and_then(Value::as_object_mut) {
                    snapshot.insert(
                        "writerInstanceId".into(),
                        Value::String(
                            string_field(step, "writerInstanceId").unwrap_or_else(|| WRITER.into()),
                        ),
                    );
                }
                self.snapshot.clone().unwrap_or(Value::Null)
            }
            Some("seedGate") => self.seed_gate(string_field(step, "now")),
            Some("readGate") => self.gate.clone().unwrap_or(Value::Null),
            Some("derive") => self.derive(
                string_array(step.get("liveSessionIds")),
                string_field(step, "now").unwrap_or_else(|| "<updatedAt>".into()),
            ),
            Some("readOffer") => self.read_offer(),
            Some("ack") => {
                self.acknowledge();
                self.read_offer()
            }
            Some("removeOfferSessions") => {
                self.remove_offer_sessions(string_array(step.get("sessionIds")))
            }
            Some("reconcile") => self.reconcile(string_array(step.get("restorableSessionIds"))),
            _ => Value::Null,
        }
    }

    fn record(&mut self, sessions: Vec<Value>, now: String) -> Value {
        let sessions = normalize_sessions(&Value::Array(sessions));
        if sessions.is_empty() {
            return self.snapshot.clone().unwrap_or(Value::Null);
        }
        if let Some(existing) = &self.snapshot
            && string_field(existing, "writerInstanceId").as_deref() == Some(WRITER)
            && same_sessions(array_field(existing, "sessions"), &sessions)
        {
            return existing.clone();
        }
        let reuse_generation = self.snapshot.as_ref().is_some_and(|existing| {
            string_field(existing, "writerInstanceId").as_deref() == Some(WRITER)
                && same_session_ids(array_field(existing, "sessions"), &sessions)
        });
        let (id, created_at) = if reuse_generation {
            let existing = self.snapshot.as_ref().expect("checked above");
            (
                string_field(existing, "id").unwrap_or_default(),
                string_field(existing, "createdAt").unwrap_or_else(|| now.clone()),
            )
        } else {
            (self.next_online_id(), now.clone())
        };
        let snapshot = json!({
            "version": 1,
            "id": id,
            "writerInstanceId": WRITER,
            "createdAt": created_at,
            "updatedAt": now,
            "sessionIds": session_ids(&sessions),
            "sessions": sessions,
            "worktreeGroups": build_worktree_groups(&sessions),
        });
        self.snapshot = Some(snapshot.clone());
        snapshot
    }

    fn remove_snapshot_sessions(&mut self, ids_to_remove: Vec<String>, now: String) -> Value {
        let Some(snapshot) = self.snapshot.clone() else {
            return Value::Null;
        };
        let removed = ids_to_remove.into_iter().collect::<BTreeSet<_>>();
        let sessions = array_field(&snapshot, "sessions")
            .into_iter()
            .filter(|session| !removed.contains(&string_field(session, "id").unwrap_or_default()))
            .collect::<Vec<_>>();
        if sessions.len() == array_field(&snapshot, "sessions").len() {
            return snapshot;
        }
        if sessions.is_empty() {
            self.snapshot = None;
            return Value::Null;
        }
        let updated = json!({
            "version": 1,
            "id": self.next_online_id(),
            "writerInstanceId": string_field(&snapshot, "writerInstanceId").unwrap_or_else(|| WRITER.into()),
            "createdAt": string_field(&snapshot, "createdAt").unwrap_or_else(|| now.clone()),
            "updatedAt": now,
            "sessionIds": session_ids(&sessions),
            "sessions": sessions,
            "worktreeGroups": build_worktree_groups(&sessions),
        });
        self.snapshot = Some(updated.clone());
        updated
    }

    fn write_file(&mut self, file: &str, body: Value) {
        match file {
            "last-online-agents.json" => self.snapshot = normalize_snapshot(&body),
            "agent-restore-offer.json" => self.offer = Some(body),
            _ => {}
        }
    }

    fn seed_gate(&mut self, now: Option<String>) -> Value {
        let now = now.unwrap_or_else(|| "2026-08-22T01:01:00.000Z".into());
        let projects = self.snapshot.as_ref().map_or_else(Map::new, |snapshot| {
            let mut projects = Map::new();
            projects.insert(
                "<project-id>".into(),
                json!({
                    "version": 1,
                    "projectId": "<project-id>",
                    "projectRoot": "<project-root>",
                    "daemonBootId": format!("daemon-{now}"),
                    "snapshotId": string_field(snapshot, "id").unwrap_or_default(),
                    "snapshotUpdatedAt": string_field(snapshot, "updatedAt").unwrap_or_default(),
                    "createdAt": now,
                }),
            );
            projects
        });
        let state = json!({
            "version": 1,
            "daemonBootId": format!("daemon-{now}"),
            "updatedAt": now,
            "projects": projects,
        });
        self.gate = state
            .get("projects")
            .and_then(|projects| projects.get("<project-id>"))
            .cloned();
        state
    }

    fn derive(&mut self, live_session_ids: Vec<String>, now: String) -> Value {
        let live = live_session_ids.into_iter().collect::<BTreeSet<_>>();
        if let Some(existing) = self.read_offer_option()
            && self.offer_has_gate(&existing)
        {
            let sessions = array_field(&existing, "sessions")
                .into_iter()
                .filter(|session| !live.contains(&string_field(session, "id").unwrap_or_default()))
                .collect::<Vec<_>>();
            if sessions.is_empty() {
                self.offer = None;
                return Value::Null;
            }
            if sessions.len() == array_field(&existing, "sessions").len() {
                return existing;
            }
            let updated = update_offer_sessions(&existing, sessions, now);
            self.offer = Some(updated.clone());
            return updated;
        }
        if let Some(existing) = self.read_offer_option()
            && !self.offer_has_gate(&existing)
        {
            self.offer = None;
        }
        let Some(snapshot) = self.snapshot.clone() else {
            return Value::Null;
        };
        if string_field(&snapshot, "writerInstanceId").as_deref() == Some(WRITER) {
            return Value::Null;
        }
        let Some(gate) = self.gate.clone() else {
            return Value::Null;
        };
        if string_field(&gate, "snapshotId") != string_field(&snapshot, "id")
            || gate.get("askedAt").is_some()
        {
            return Value::Null;
        }
        if self.ack_snapshot_id == string_field(&snapshot, "id") {
            self.offer = None;
            return Value::Null;
        }
        let sessions = array_field(&snapshot, "sessions")
            .into_iter()
            .filter(|session| !live.contains(&string_field(session, "id").unwrap_or_default()))
            .collect::<Vec<_>>();
        if sessions.is_empty() {
            self.offer = None;
            return Value::Null;
        }
        let snapshot_id = string_field(&snapshot, "id").unwrap_or_else(|| "unknown".into());
        let offer = json!({
            "version": 1,
            "id": format!("restore-{snapshot_id}"),
            "snapshotId": snapshot_id,
            "snapshotUpdatedAt": string_field(&snapshot, "updatedAt").unwrap_or_else(|| now.clone()),
            "source": "last-online",
            "createdAt": now,
            "updatedAt": now,
            "sessionIds": session_ids(&sessions),
            "sessions": sessions,
            "worktreeGroups": build_worktree_groups(&sessions),
        });
        self.offer = Some(offer.clone());
        offer
    }

    fn read_offer(&mut self) -> Value {
        self.read_offer_option().unwrap_or(Value::Null)
    }

    fn read_offer_option(&mut self) -> Option<Value> {
        let offer = self.offer.clone()?;
        if string_field(&offer, "source").as_deref() == Some("restorable-inventory") {
            self.offer = None;
            return None;
        }
        let normalized = normalize_offer(&offer)?;
        self.offer = Some(normalized.clone());
        Some(normalized)
    }

    fn acknowledge(&mut self) {
        if let Some(offer) = self.read_offer_option()
            && let Some(snapshot_id) = string_field(&offer, "snapshotId")
            && !snapshot_id.is_empty()
        {
            self.ack_snapshot_id = Some(snapshot_id);
        }
        self.offer = None;
    }

    fn remove_offer_sessions(&mut self, session_ids: Vec<String>) -> Value {
        let Some(offer) = self.read_offer_option() else {
            return Value::Null;
        };
        let removed = session_ids.into_iter().collect::<BTreeSet<_>>();
        let sessions = array_field(&offer, "sessions")
            .into_iter()
            .filter(|session| !removed.contains(&string_field(session, "id").unwrap_or_default()))
            .collect::<Vec<_>>();
        if sessions.is_empty() {
            self.acknowledge();
            return Value::Null;
        }
        let updated = update_offer_sessions(&offer, sessions, "<updatedAt>".into());
        self.offer = Some(updated.clone());
        updated
    }

    fn reconcile(&mut self, restorable_ids: Vec<String>) -> Value {
        let Some(offer) = self.read_offer_option() else {
            return Value::Null;
        };
        let restorable = restorable_ids.into_iter().collect::<BTreeSet<_>>();
        let sessions = array_field(&offer, "sessions")
            .into_iter()
            .filter(|session| restorable.contains(&string_field(session, "id").unwrap_or_default()))
            .collect::<Vec<_>>();
        if sessions.len() == array_field(&offer, "sessions").len() {
            self.mark_gate_asked(&offer);
            return offer;
        }
        if sessions.is_empty() {
            self.acknowledge();
            return Value::Null;
        }
        let updated = update_offer_sessions(&offer, sessions, "<updatedAt>".into());
        self.offer = Some(updated.clone());
        self.mark_gate_asked(&updated);
        updated
    }

    fn mark_gate_asked(&mut self, offer: &Value) {
        if self.gate.as_ref().is_some_and(|gate| {
            string_field(gate, "snapshotId") == string_field(offer, "snapshotId")
        }) && let Some(gate) = self.gate.as_mut().and_then(Value::as_object_mut)
            && !gate.contains_key("askedAt")
        {
            gate.insert("askedAt".into(), Value::String("<asked-at>".into()));
        }
    }

    fn offer_has_gate(&self, offer: &Value) -> bool {
        self.gate.as_ref().is_some_and(|gate| {
            string_field(gate, "snapshotId") == string_field(offer, "snapshotId")
        })
    }

    fn next_online_id(&mut self) -> String {
        self.next_online_id += 1;
        format!("<online-{}>", self.next_online_id)
    }
}

fn normalize_snapshot(value: &Value) -> Option<Value> {
    let sessions = normalize_sessions(value.get("sessions")?);
    if sessions.is_empty() {
        return None;
    }
    Some(json!({
        "version": 1,
        "id": string_field(value, "id").unwrap_or_else(|| format!("online-{}", session_ids(&sessions).join("-"))),
        "writerInstanceId": string_field(value, "writerInstanceId").unwrap_or_else(|| "unknown".into()),
        "createdAt": string_field(value, "createdAt").unwrap_or_default(),
        "updatedAt": string_field(value, "updatedAt").unwrap_or_default(),
        "sessionIds": session_ids(&sessions),
        "sessions": sessions,
        "worktreeGroups": build_worktree_groups(&sessions),
    }))
}

fn normalize_offer(value: &Value) -> Option<Value> {
    if string_field(value, "source").as_deref() == Some("restorable-inventory") {
        return None;
    }
    let sessions = normalize_sessions(value.get("sessions")?);
    if sessions.is_empty() {
        return None;
    }
    let snapshot_id = string_field(value, "snapshotId").unwrap_or_else(|| "unknown".into());
    Some(json!({
        "version": 1,
        "id": string_field(value, "id").unwrap_or_else(|| format!("restore-{snapshot_id}")),
        "snapshotId": snapshot_id,
        "snapshotUpdatedAt": string_field(value, "snapshotUpdatedAt").unwrap_or_default(),
        "source": "last-online",
        "createdAt": string_field(value, "createdAt").unwrap_or_default(),
        "updatedAt": string_field(value, "updatedAt").unwrap_or_default(),
        "sessionIds": session_ids(&sessions),
        "sessions": sessions,
        "worktreeGroups": build_worktree_groups(&sessions),
    }))
}

fn normalize_sessions(value: &Value) -> Vec<Value> {
    let mut sessions = Vec::<Value>::new();
    for raw in value.as_array().into_iter().flatten() {
        let Some(session) = normalize_session(raw) else {
            continue;
        };
        let id = string_field(&session, "id").unwrap_or_default();
        if let Some(index) = sessions
            .iter()
            .position(|existing| string_field(existing, "id").as_deref() == Some(id.as_str()))
        {
            sessions[index] = session;
        } else {
            sessions.push(session);
        }
    }
    sessions
}

fn normalize_session(value: &Value) -> Option<Value> {
    let id = trimmed_field(value, "id")?;
    let mut session = Map::new();
    session.insert("id".into(), Value::String(id));
    for key in ["tool", "command", "label", "worktreePath"] {
        if let Some(item) = trimmed_field(value, key) {
            session.insert(key.into(), Value::String(item));
        }
    }
    if let Some(team) = normalize_team(value.get("team")) {
        session.insert("team".into(), team);
    }
    for key in ["overseer", "scribe", "projectControl"] {
        if let Some(item) = value.get(key).and_then(Value::as_bool) {
            session.insert(key.into(), Value::Bool(item));
        }
    }
    Some(Value::Object(session))
}

fn normalize_team(value: Option<&Value>) -> Option<Value> {
    let record = value.and_then(Value::as_object)?;
    let team_id = trimmed_string(record.get("teamId")?)?;
    let parent_session_id = trimmed_string(record.get("parentSessionId")?)?;
    let mut team = Map::new();
    team.insert("teamId".into(), Value::String(team_id));
    team.insert("parentSessionId".into(), Value::String(parent_session_id));
    for key in ["role", "label"] {
        if let Some(item) = record.get(key).and_then(trimmed_string) {
            team.insert(key.into(), Value::String(item));
        }
    }
    if let Some(order) = record.get("order").and_then(Value::as_f64) {
        team.insert("order".into(), json!(order));
    }
    Some(Value::Object(team))
}

fn update_offer_sessions(offer: &Value, sessions: Vec<Value>, updated_at: String) -> Value {
    json!({
        "version": 1,
        "id": string_field(offer, "id").unwrap_or_default(),
        "snapshotId": string_field(offer, "snapshotId").unwrap_or_default(),
        "snapshotUpdatedAt": string_field(offer, "snapshotUpdatedAt").unwrap_or_default(),
        "source": "last-online",
        "createdAt": string_field(offer, "createdAt").unwrap_or_default(),
        "updatedAt": updated_at,
        "sessionIds": session_ids(&sessions),
        "sessions": sessions,
        "worktreeGroups": build_worktree_groups(&sessions),
    })
}

fn session_ids(sessions: &[Value]) -> Vec<String> {
    sessions
        .iter()
        .filter_map(|session| string_field(session, "id"))
        .collect()
}

fn build_worktree_groups(sessions: &[Value]) -> Vec<Value> {
    let mut groups = BTreeMap::<String, (String, i64)>::new();
    for session in sessions {
        let path = string_field(session, "worktreePath");
        let key = worktree_group_key(path.as_deref());
        let name = worktree_group_name(path.as_deref());
        groups
            .entry(key)
            .and_modify(|entry| entry.1 += 1)
            .or_insert((name, 1));
    }
    let mut values = groups
        .into_iter()
        .map(|(path, (name, count))| {
            if path.is_empty() {
                json!({ "name": name, "count": count })
            } else {
                json!({ "path": path, "name": name, "count": count })
            }
        })
        .collect::<Vec<_>>();
    values.sort_by(|left, right| {
        let left_name = string_field(left, "name").unwrap_or_default();
        let right_name = string_field(right, "name").unwrap_or_default();
        match (
            left_name.as_str() == "Main Checkout",
            right_name.as_str() == "Main Checkout",
        ) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => left_name.cmp(&right_name),
        }
    });
    values
}

fn worktree_group_name(path: Option<&str>) -> String {
    let Some(path) = path else {
        return "Main Checkout".into();
    };
    let marker = "/.aimux/worktrees/";
    path.find(marker).map_or_else(
        || "Main Checkout".into(),
        |index| {
            path[index + marker.len()..]
                .split('/')
                .next()
                .filter(|name| !name.is_empty())
                .unwrap_or(path)
                .to_owned()
        },
    )
}

fn worktree_group_key(path: Option<&str>) -> String {
    let Some(path) = path else {
        return String::new();
    };
    let marker = "/.aimux/worktrees/";
    let Some(index) = path.find(marker) else {
        return String::new();
    };
    let name = worktree_group_name(Some(path));
    path[..index + marker.len() + name.len()].to_owned()
}

fn same_session_ids(left: Vec<Value>, right: &[Value]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right.iter())
            .all(|(left, right)| string_field(left, "id") == string_field(right, "id"))
}

fn same_sessions(left: Vec<Value>, right: &[Value]) -> bool {
    same_session_ids(left.clone(), right)
        && left.iter().zip(right.iter()).all(|(left, right)| {
            ["tool", "command", "label", "worktreePath"]
                .into_iter()
                .all(|key| string_field(left, key) == string_field(right, key))
                && left.get("team") == right.get("team")
                && ["overseer", "scribe", "projectControl"]
                    .into_iter()
                    .all(|key| {
                        left.get(key).and_then(Value::as_bool)
                            == right.get(key).and_then(Value::as_bool)
                    })
        })
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect()
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn trimmed_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(trimmed_string)
}

fn trimmed_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToOwned::to_owned)
}

fn normalize_contract_value(value: Value) -> Value {
    match value {
        Value::Array(items) => {
            Value::Array(items.into_iter().map(normalize_contract_value).collect())
        }
        Value::Object(map) => {
            let mut next = Map::new();
            for (key, value) in map {
                if key == "writerInstanceId" {
                    next.insert(key, Value::String(WRITER.into()));
                } else {
                    next.insert(key, normalize_contract_value(value));
                }
            }
            Value::Object(next)
        }
        value => value,
    }
}
