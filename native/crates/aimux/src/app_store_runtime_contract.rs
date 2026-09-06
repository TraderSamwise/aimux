use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

const FIXED_NOW: i64 = 1_788_523_200_000;
const LOCAL_INTERRUPT_ACTIVITY_HOLD_MS: i64 = 5_000;

pub fn run_app_chat_output_contract_case(input: &Value) -> Value {
    let mut state = ChatState {
        now: FIXED_NOW,
        ..ChatState::default()
    };
    for action in array_field(input, "actions") {
        state.apply_action(action);
    }
    state.output()
}

pub fn run_app_project_list_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "reconcileProjectList" => reconcile_project_list_case(input),
        "reconcileProjectsAtom" => reconcile_projects_atom_case(input),
        "selectProjectAtom" => {
            let project_path = input.get("projectPath").cloned().unwrap_or(Value::Null);
            json!({
                "selectedProjectPath": project_path,
                "selectedSessionId": Value::Null,
                "explicitProjectSelection": {
                    "path": project_path.as_str().unwrap_or_default(),
                    "expiresAt": FIXED_NOW + 1_500,
                },
                "explicitHoldMs": 1_500,
            })
        }
        "rememberProjectViewPath" => {
            let mut memory = BTreeMap::<String, String>::new();
            for call in array_field(input, "calls") {
                let project_path = str_field(call, "projectPath");
                let view_path = str_field(call, "viewPath");
                if !project_path.is_empty() && !view_path.is_empty() {
                    memory.insert(project_path.to_owned(), view_path.to_owned());
                }
            }
            json!(
                array_field(input, "lookups")
                    .iter()
                    .map(|lookup| {
                        lookup
                            .as_str()
                            .and_then(|project_path| memory.get(project_path))
                            .map(|value| Value::String(value.clone()))
                            .unwrap_or(Value::Null)
                    })
                    .collect::<Vec<_>>()
            )
        }
        api => panic!("unknown app project list contract api: {api}"),
    }
}

pub fn run_app_resource_request_tracker_contract_case(input: &Value) -> Value {
    let mut tracker = ProjectResourceRequestTracker::new(input.get("initialScope").unwrap());
    let mut markers = BTreeMap::<String, Value>::new();
    let mut current = Map::<String, Value>::new();
    for action in array_field(input, "actions") {
        match str_field(action, "kind") {
            "begin" => {
                markers.insert(str_field(action, "as").to_owned(), tracker.begin());
            }
            "update" => tracker.update(action.get("scope").unwrap()),
            "invalidate" => tracker.invalidate(),
            "invalidateGeneration" => tracker.invalidate_generation(),
            "isCurrent" => {
                let marker_name = str_field(action, "marker");
                let is_current = markers
                    .get(marker_name)
                    .is_some_and(|marker| tracker.is_current(marker));
                current.insert(marker_name.to_owned(), Value::Bool(is_current));
            }
            kind => panic!("unknown resource tracker action: {kind}"),
        }
    }
    json!({ "markers": markers, "current": Value::Object(current) })
}

pub fn run_app_ui_defaults_contract_case(_input: &Value) -> Value {
    json!({
        "sidebarOpen": true,
        "sidebarMode": "dashboard",
        "sidebarShowProjectPicker": false,
        "sidebarProjectPickerShowAll": false,
    })
}

#[derive(Default)]
struct ChatState {
    now: i64,
    output: String,
    output_ansi: String,
    output_available: bool,
    transcript: Vec<Value>,
    transcript_start_line: Option<i64>,
    activity: Option<String>,
    activity_text: String,
    last_error: Option<String>,
    streaming: bool,
    local_interrupted_until: i64,
}

impl ChatState {
    fn apply_action(&mut self, action: &Value) {
        match str_field(action, "kind") {
            "setNow" => self.now = FIXED_NOW,
            "advanceMs" => self.now += int_field(action, "value"),
            "ingestEvent" => self.ingest_event(action.get("value").unwrap()),
            "snapshot" => {
                self.apply_payload(
                    action.get("value").unwrap(),
                    PayloadOptions {
                        sparse_activity: false,
                    },
                );
            }
            "markInterrupted" => {
                self.local_interrupted_until = self.now + LOCAL_INTERRUPT_ACTIVITY_HOLD_MS;
                self.apply_payload(
                    &json!({
                        "sessionId": str_field(action, "sessionId"),
                        "activity": "interrupted",
                        "activityText": "",
                    }),
                    PayloadOptions {
                        sparse_activity: false,
                    },
                );
            }
            "clearInterruptHold" => {
                self.local_interrupted_until = 0;
            }
            kind => panic!("unknown chat action: {kind}"),
        }
    }

    fn ingest_event(&mut self, event: &Value) {
        match str_field(event, "type") {
            "ready" => {
                if event.get("sessionId").and_then(Value::as_str).is_some() {
                    self.streaming = false;
                    self.last_error = None;
                }
            }
            "agent_output" => {
                self.apply_payload(
                    event,
                    PayloadOptions {
                        sparse_activity: true,
                    },
                );
                self.streaming = true;
            }
            "alert" => {
                if event.get("sessionId").and_then(Value::as_str).is_none() {
                    return;
                }
                if matches!(str_field(event, "kind"), "task_done" | "task_failed") {
                    self.streaming = false;
                }
            }
            "error" => {
                self.last_error = Some(str_field(event, "error").to_owned());
                self.streaming = false;
            }
            event_type => panic!("unknown stream event type: {event_type}"),
        }
    }

    fn apply_payload(&mut self, payload: &Value, options: PayloadOptions) {
        let output = payload.get("output").and_then(Value::as_str);
        let output_ansi = payload.get("outputAnsi").and_then(Value::as_str);
        let output_available = payload.get("outputAvailable").and_then(Value::as_bool);

        if let Some(output) = output {
            self.output = output.to_owned();
            self.output_ansi = output_ansi.unwrap_or(output).to_owned();
            self.output_available = !output.is_empty() || output_available.unwrap_or(false);
        } else if let Some(output_ansi) = output_ansi {
            self.output_ansi = output_ansi.to_owned();
            self.output_available = !output_ansi.is_empty() || output_available.unwrap_or(false);
        } else if let Some(output_available) = output_available {
            self.output_available = output_available;
        }

        if let Some(messages) = payload.get("messages") {
            self.apply_transcript_messages(
                messages.as_array().cloned().unwrap_or_default(),
                payload.get("startLine").and_then(Value::as_i64),
            );
        } else if output.is_some() {
            self.transcript.clear();
            self.transcript_start_line = payload.get("startLine").and_then(Value::as_i64);
        }

        let activity_present = payload.get("activity").is_some();
        let activity = payload
            .get("activity")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let activity_text = payload.get("activityText").and_then(Value::as_str);
        let local_interrupt_active = self.activity.as_deref() == Some("interrupted")
            && self.local_interrupted_until > self.now;
        let incoming_looks_like_stale_progress = activity.as_deref() == Some("running")
            || (activity.is_none() && activity_text.is_some_and(|text| !text.trim().is_empty()));
        let preserve_local_interrupt = local_interrupt_active
            && (incoming_looks_like_stale_progress
                || (!options.sparse_activity && !activity_present));

        if (!options.sparse_activity || activity_present) && !preserve_local_interrupt {
            self.activity = activity;
            if self.activity.as_deref() != Some("interrupted") {
                self.local_interrupted_until = 0;
            }
        }
        if let Some(activity_text) = activity_text
            && !preserve_local_interrupt
        {
            self.activity_text = activity_text.to_owned();
        }
        self.last_error = None;
    }

    fn apply_transcript_messages(&mut self, messages: Vec<Value>, start_line: Option<i64>) {
        if start_line.is_none()
            || self.transcript_start_line.is_none()
            || start_line <= self.transcript_start_line
        {
            self.transcript = messages;
            self.transcript_start_line = start_line;
            return;
        }

        let overlap = longest_transcript_overlap(&self.transcript, &messages);
        let prefix_len = self.transcript.len() - overlap;
        let mut merged = self
            .transcript
            .iter()
            .take(prefix_len)
            .map(strip_latest_marker)
            .collect::<Vec<_>>();
        merged.extend(messages);
        self.transcript = merged;
    }

    fn output(&self) -> Value {
        json!({
            "output": self.output,
            "outputAnsi": self.output_ansi,
            "outputAvailable": self.output_available,
            "transcript": self.transcript,
            "transcriptIds": self
                .transcript
                .iter()
                .map(|message| message.get("id").cloned().unwrap_or(Value::Null))
                .collect::<Vec<_>>(),
            "transcriptStartLine": self.transcript_start_line.map(Value::from).unwrap_or(Value::Null),
            "activity": self.activity.clone().map(Value::from).unwrap_or(Value::Null),
            "activityText": self.activity_text,
            "lastError": self.last_error.clone().map(Value::from).unwrap_or(Value::Null),
        })
    }
}

struct PayloadOptions {
    sparse_activity: bool,
}

fn longest_transcript_overlap(existing: &[Value], incoming: &[Value]) -> usize {
    let max_overlap = existing.len().min(incoming.len());
    for length in (1..=max_overlap).rev() {
        let matches = (0..length).all(|index| {
            transcript_message_matches(&existing[existing.len() - length + index], &incoming[index])
        });
        if matches {
            return length;
        }
    }
    0
}

fn transcript_message_matches(left: &Value, right: &Value) -> bool {
    left.get("role") == right.get("role")
        && left.get("text") == right.get("text")
        && left.get("parts") == right.get("parts")
}

fn strip_latest_marker(message: &Value) -> Value {
    if message.get("latest").and_then(Value::as_bool) != Some(true) {
        return message.clone();
    }
    let mut object = message.as_object().cloned().unwrap_or_default();
    object.remove("latest");
    Value::Object(object)
}

#[derive(Clone)]
struct ProjectResourceRequestTracker {
    seq: i64,
    generation: i64,
    request_key_sequence: i64,
    current_scope: Value,
}

impl ProjectResourceRequestTracker {
    fn new(initial_scope: &Value) -> Self {
        let mut current_scope = initial_scope.clone();
        current_scope["generation"] = Value::from(0);
        Self {
            seq: 0,
            generation: 0,
            request_key_sequence: 0,
            current_scope,
        }
    }

    fn update(&mut self, scope: &Value) {
        self.generation += 1;
        self.current_scope = scope.clone();
        self.current_scope["generation"] = Value::from(self.generation);
    }

    fn begin(&mut self) -> Value {
        self.seq += 1;
        self.request_key_sequence += 1;
        json!({
            "seq": self.seq,
            "requestKey": project_resource_request_key(&self.current_scope, self.request_key_sequence),
            "scope": self.current_scope,
        })
    }

    fn invalidate(&mut self) {
        self.seq += 1;
    }

    fn invalidate_generation(&mut self) {
        self.seq += 1;
        self.generation += 1;
        self.current_scope["generation"] = Value::from(self.generation);
    }

    fn is_current(&self, marker: &Value) -> bool {
        int_field(marker, "seq") == self.seq
            && is_current_scope(
                marker.get("scope").unwrap_or(&Value::Null),
                &self.current_scope,
            )
    }
}

fn project_resource_request_key(scope: &Value, sequence: i64) -> String {
    format!(
        "{}\0{}\0{}\0<scope:1>\0<request-seq:{}>",
        str_field(scope, "projectPath"),
        scope
            .get("endpointKey")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        int_field(scope, "generation"),
        sequence,
    )
}

fn is_current_scope(request: &Value, current: &Value) -> bool {
    str_field(request, "projectPath") == str_field(current, "projectPath")
        && request.get("endpointKey") == current.get("endpointKey")
        && int_field(request, "generation") == int_field(current, "generation")
}

fn reconcile_project_list_case(input: &Value) -> Value {
    let previous = projects_from(input, "previous");
    let sorted = sorted_projects_from(input, "incoming");
    let same_reference = previous.len() == sorted.len()
        && previous
            .iter()
            .zip(sorted.iter())
            .all(|(left, right)| left == right);
    project_list_summary(&sorted, same_reference)
}

fn reconcile_projects_atom_case(input: &Value) -> Value {
    let seed = input.get("seed").unwrap();
    let previous = projects_from(seed, "projects");
    let mut sorted = sorted_projects_from(input, "incoming");
    let mut next_path = seed
        .get("selectedProjectPath")
        .cloned()
        .unwrap_or(Value::Null);
    let mut next_session = seed
        .get("selectedSessionId")
        .cloned()
        .unwrap_or(Value::Null);

    if sorted.is_empty()
        && !previous.is_empty()
        && preserving_recent_explicit_selection(seed, &next_path)
    {
        return json!({
            "projectPaths": previous
                .iter()
                .map(|project| project_path(project))
                .collect::<Vec<_>>(),
            "selectedProjectPath": next_path,
            "selectedSessionId": next_session,
            "lastSyncAt": FIXED_NOW,
        });
    }

    let still_present = next_path
        .as_str()
        .is_some_and(|path| sorted.iter().any(|project| project_path(project) == path));
    if next_path.is_null() && !sorted.is_empty() {
        next_path = Value::from(project_path(sorted[0]));
    } else if !next_path.is_null() && !still_present {
        next_path = sorted
            .first()
            .map(|project| project_path(project))
            .map(Value::from)
            .unwrap_or(Value::Null);
        next_session = Value::Null;
    }

    if sorted.is_empty() {
        sorted = Vec::new();
    }

    json!({
        "projectPaths": sorted
            .iter()
            .map(|project| project_path(project))
            .collect::<Vec<_>>(),
        "selectedProjectPath": next_path,
        "selectedSessionId": next_session,
        "lastSyncAt": FIXED_NOW,
    })
}

fn preserving_recent_explicit_selection(seed: &Value, next_path: &Value) -> bool {
    let Some(explicit) = seed.get("explicitProjectSelection") else {
        return false;
    };
    explicit.get("path") == Some(next_path)
        && explicit
            .get("expiresAt")
            .and_then(Value::as_i64)
            .is_some_and(|expires_at| expires_at > FIXED_NOW)
}

fn projects_from<'a>(value: &'a Value, field: &str) -> Vec<&'a Value> {
    array_field(value, field).iter().collect()
}

fn sorted_projects_from<'a>(value: &'a Value, field: &str) -> Vec<&'a Value> {
    let mut projects = projects_from(value, field);
    projects.sort_by(|left, right| {
        str_field(left, "name")
            .cmp(str_field(right, "name"))
            .then_with(|| str_field(left, "path").cmp(str_field(right, "path")))
            .then_with(|| str_field(left, "id").cmp(str_field(right, "id")))
    });
    projects
}

fn project_list_summary(projects: &[&Value], same_reference: bool) -> Value {
    json!({
        "sameReference": same_reference,
        "ids": projects.iter().map(|project| str_field(project, "id")).collect::<Vec<_>>(),
        "names": projects.iter().map(|project| str_field(project, "name")).collect::<Vec<_>>(),
        "paths": projects.iter().map(|project| str_field(project, "path")).collect::<Vec<_>>(),
    })
}

fn project_path(project: &Value) -> &str {
    str_field(project, "path")
}

fn array_field<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn int_field(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or(0)
}
