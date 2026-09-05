use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::project_api_contract::routes;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::http::{query_params, trimmed_query};
use super::metadata::update_session_metadata;
use super::notification_context::is_session_notification_focused;
use super::notifications::{NotificationWriteInput, add_notification};
use super::router::ProjectServiceRequestContext;

const SETTLED_TTL_MS: u128 = 5 * 60_000;
const DEFAULT_WAIT_MS: u64 = 110_000;
const MIN_WAIT_MS: u64 = 1_000;
const MAX_WAIT_MS: u64 = 600_000;
static INTERACTION_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static REGISTRIES: OnceLock<Mutex<BTreeMap<String, Arc<ProjectInteractionRegistry>>>> =
    OnceLock::new();

pub fn route_interaction_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    let pathname = project_service_pathname(path);
    let project_state_dir = context.project_state_dir();
    match (method.to_ascii_uppercase().as_str(), pathname) {
        ("POST", routes::agents::INTERACTION_REGISTER) => Some(route_register(
            context,
            &project_state_dir,
            body.unwrap_or(&Value::Null),
        )),
        ("POST", routes::agents::INTERACTION_NOTIFY) => Some(route_notify(
            context,
            &project_state_dir,
            body.unwrap_or(&Value::Null),
        )),
        ("POST", routes::agents::INTERACTION_REQUEST) => Some(route_request(
            context,
            &project_state_dir,
            body.unwrap_or(&Value::Null),
        )),
        ("GET", routes::agents::INTERACTION_WAIT) => Some(route_wait(&project_state_dir, path)),
        ("POST", routes::agents::INTERACTION_RESPOND) => Some(route_respond(
            &project_state_dir,
            body.unwrap_or(&Value::Null),
        )),
        ("GET", routes::agents::INTERACTION_PENDING) => {
            Some(route_pending(&project_state_dir, path))
        }
        _ => None,
    }
}

fn route_register(
    context: &ProjectServiceRequestContext,
    project_state_dir: &Path,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let Some(input) = parse_interaction_input(body) else {
        return json_response(
            400,
            json!({ "ok": false, "error": "session and a valid type are required" }),
        );
    };
    if !is_plain_object(body.get("payload")) {
        return json_response(
            400,
            json!({ "ok": false, "error": "payload must be an object" }),
        );
    }
    match begin_interaction(context, project_state_dir, input) {
        Ok(request) => json_response(200, json!({ "ok": true, "request": request })),
        Err(error) => json_response(500, json!({ "ok": false, "error": error })),
    }
}

fn route_notify(
    context: &ProjectServiceRequestContext,
    project_state_dir: &Path,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let session_id = trimmed_field(body, "session");
    let Some(session_id) = session_id else {
        return json_response(400, json!({ "ok": false, "error": "session is required" }));
    };
    let payload = body.get("payload").and_then(Value::as_object);
    let tool_name = payload
        .and_then(|payload| payload.get("toolName"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let input = payload
        .and_then(|payload| payload.get("input"))
        .filter(|input| input.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let cwd = payload
        .and_then(|payload| payload.get("cwd"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let summary = trimmed_field(body, "summary");
    let fallback_message = "Agent is waiting on a permission response.";
    let message = summary
        .clone()
        .unwrap_or_else(|| fallback_message.to_owned());
    if let Err(error) = set_session_attention(project_state_dir, &session_id, "needs_input") {
        return json_response(500, json!({ "ok": false, "error": error }));
    }
    let dedupe_key = interaction_dedupe_key(
        &session_id,
        "permission",
        &json!({ "toolName": tool_name, "input": input, "cwd": cwd }),
        summary.as_deref(),
    );
    let interaction = json!({
        "id": unique_interaction_id(),
        "type": "permission",
        "summary": optional_json_string(summary.as_deref()),
        "telemetry": true,
        "toolName": optional_json_string(tool_name.as_deref()),
        "toolInputJSON": serde_json::to_string(&input).ok(),
    });
    let focused = is_session_notification_focused(project_state_dir, &session_id);
    let notification = contextualized_interaction_notification(
        context,
        InteractionAlertInput {
            session_id: session_id.clone(),
            title: format!("{session_id} needs a response"),
            message,
            interaction_type: "permission".to_owned(),
            telemetry: true,
            dedupe_key,
            display_context: resolve_session_display_context(context, &session_id, cwd.as_deref()),
            interaction,
            unread: !focused,
        },
    );
    match add_notification(project_state_dir, notification) {
        Ok(_) => json_response(200, json!({ "ok": true, "telemetry": true })),
        Err(error) => json_response(500, json!({ "ok": false, "error": error })),
    }
}

fn route_request(
    context: &ProjectServiceRequestContext,
    project_state_dir: &Path,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let Some(input) = parse_interaction_input(body) else {
        return json_response(
            400,
            json!({ "ok": false, "error": "session and a valid type are required" }),
        );
    };
    if !is_plain_object(body.get("payload")) {
        return json_response(
            400,
            json!({ "ok": false, "error": "payload must be an object" }),
        );
    }
    let registry = registry_for(project_state_dir);
    if registry.watcher_count() == 0 {
        return json_response(200, json!({ "ok": true, "watching": false }));
    }
    let request = match begin_interaction(context, project_state_dir, input) {
        Ok(request) => request,
        Err(error) => return json_response(500, json!({ "ok": false, "error": error })),
    };
    let timeout_ms = bounded_timeout_ms(body.get("timeoutMs").and_then(Value::as_i64));
    let settled = registry.wait(string_field(&request, "id").unwrap_or(""), timeout_ms);
    clear_attention_if_no_pending(project_state_dir, &settled);
    json_response(200, json!({ "ok": true, "request": settled }))
}

fn route_wait(project_state_dir: &Path, path: &str) -> ProjectServiceDispatchResponse {
    let params = query_params(path);
    let Some(id) = trimmed_query(&params, "id") else {
        return json_response(400, json!({ "ok": false, "error": "id is required" }));
    };
    let timeout = params
        .get("timeoutMs")
        .and_then(|value| value.parse::<i64>().ok());
    let request = registry_for(project_state_dir).wait(&id, bounded_timeout_ms(timeout));
    json_response(200, json!({ "ok": true, "request": request }))
}

fn route_respond(project_state_dir: &Path, body: &Value) -> ProjectServiceDispatchResponse {
    let Some(id) = trimmed_field(body, "id") else {
        return json_response(400, json!({ "ok": false, "error": "id is required" }));
    };
    if !is_plain_or_null(body.get("response")) {
        return json_response(
            400,
            json!({ "ok": false, "error": "response must be an object" }),
        );
    }
    let response = body
        .get("response")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let registry = registry_for(project_state_dir);
    let Some(request) = registry.resolve(&id, response) else {
        return json_response(
            409,
            json!({ "ok": false, "error": "no pending interaction for id" }),
        );
    };
    clear_attention_if_no_pending(project_state_dir, &request);
    json_response(200, json!({ "ok": true, "request": request }))
}

fn route_pending(project_state_dir: &Path, path: &str) -> ProjectServiceDispatchResponse {
    let params = query_params(path);
    let session_id = trimmed_query(&params, "sessionId");
    let requests = registry_for(project_state_dir).list_pending(session_id.as_deref());
    json_response(200, json!({ "ok": true, "requests": requests }))
}

#[derive(Debug, Clone)]
struct InteractionInput {
    session_id: String,
    interaction_type: String,
    payload: Value,
    summary: Option<String>,
    id: Option<String>,
}

fn begin_interaction(
    context: &ProjectServiceRequestContext,
    project_state_dir: &Path,
    input: InteractionInput,
) -> Result<Value, String> {
    let display = summarize_interaction_for_display(&input);
    let dedupe_key = interaction_dedupe_key(
        &input.session_id,
        &input.interaction_type,
        &input.payload,
        input.summary.as_deref(),
    );
    let registry = registry_for(project_state_dir);
    let registration = registry.register(RegisterInteractionInput {
        session_id: input.session_id.clone(),
        project_root: Some(context.project_root().to_string_lossy().into_owned()),
        dedupe_key: Some(dedupe_key.clone()),
        interaction_type: input.interaction_type.clone(),
        payload: input.payload.clone(),
        id: input.id.clone(),
    });
    set_session_attention(project_state_dir, &input.session_id, "needs_response")?;
    if registration.created {
        let interaction = json!({
            "id": string_field(&registration.request, "id").unwrap_or(""),
            "type": input.interaction_type,
            "summary": optional_json_string(display.summary.as_deref()),
        });
        let display_context = resolve_session_display_context(context, &input.session_id, None);
        let notification = contextualized_interaction_notification(
            context,
            InteractionAlertInput {
                session_id: input.session_id,
                title: display.title,
                message: display.message,
                interaction_type: interaction
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("input")
                    .to_owned(),
                telemetry: false,
                dedupe_key,
                display_context,
                interaction,
                unread: true,
            },
        );
        add_notification(project_state_dir, notification)?;
    }
    Ok(registration.request)
}

#[derive(Debug)]
struct RegisterInteractionInput {
    session_id: String,
    project_root: Option<String>,
    dedupe_key: Option<String>,
    interaction_type: String,
    payload: Value,
    id: Option<String>,
}

#[derive(Debug, Clone)]
struct InteractionRegistration {
    request: Value,
    created: bool,
}

#[derive(Debug, Default)]
struct InteractionRegistry {
    requests: BTreeMap<String, Value>,
}

#[derive(Debug, Default)]
struct ProjectInteractionRegistry {
    inner: Mutex<InteractionRegistry>,
    changed: Condvar,
    watcher_count: AtomicU64,
}

impl ProjectInteractionRegistry {
    fn register_watcher(self: &Arc<Self>) -> InteractionWatcherGuard {
        self.watcher_count.fetch_add(1, Ordering::Relaxed);
        InteractionWatcherGuard {
            registry: Arc::clone(self),
        }
    }

    fn register(&self, input: RegisterInteractionInput) -> InteractionRegistration {
        let mut registry = self.inner.lock().expect("interaction registry poisoned");
        registry.prune_settled();
        if let Some(dedupe_key) = input.dedupe_key.as_deref()
            && let Some(existing) = registry.find_pending_by_dedupe_key(dedupe_key)
        {
            return InteractionRegistration {
                request: existing,
                created: false,
            };
        }
        let id = input
            .id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(unique_interaction_id);
        let mut request = Map::new();
        request.insert("id".into(), Value::String(id.clone()));
        request.insert("sessionId".into(), Value::String(input.session_id));
        insert_optional_string(&mut request, "projectRoot", input.project_root.as_deref());
        insert_optional_string(&mut request, "dedupeKey", input.dedupe_key.as_deref());
        request.insert("type".into(), Value::String(input.interaction_type));
        request.insert("payload".into(), input.payload);
        request.insert("status".into(), Value::String("pending".to_owned()));
        request.insert("createdAt".into(), Value::String(now_iso()));
        let request = Value::Object(request);
        registry.requests.insert(id, request.clone());
        self.changed.notify_all();
        InteractionRegistration {
            request,
            created: true,
        }
    }

    fn list_pending(&self, session_id: Option<&str>) -> Vec<Value> {
        let registry = self.inner.lock().expect("interaction registry poisoned");
        registry.list_pending(session_id)
    }

    fn resolve(&self, id: &str, response: Value) -> Option<Value> {
        let mut registry = self.inner.lock().expect("interaction registry poisoned");
        let request = registry.settle(id, "resolved", Some(response));
        if request.is_some() {
            self.changed.notify_all();
        }
        request
    }

    fn wait(&self, id: &str, timeout_ms: u64) -> Value {
        let deadline = SystemTime::now() + Duration::from_millis(timeout_ms);
        let mut registry = self.inner.lock().expect("interaction registry poisoned");
        loop {
            if let Some(request) = registry.requests.get(id)
                && request.get("status").and_then(Value::as_str) != Some("pending")
            {
                return request.clone();
            }
            let now = SystemTime::now();
            if now >= deadline {
                let request = registry
                    .settle(id, "timed_out", None)
                    .unwrap_or_else(|| missing_interaction(id));
                self.changed.notify_all();
                return request;
            }
            let wait_for = deadline
                .duration_since(now)
                .unwrap_or_else(|_| Duration::from_millis(0));
            let (next_registry, _) = self
                .changed
                .wait_timeout(registry, wait_for)
                .expect("interaction registry poisoned");
            registry = next_registry;
        }
    }

    fn watcher_count(&self) -> u64 {
        self.watcher_count.load(Ordering::Relaxed)
    }
}

#[derive(Debug)]
pub struct InteractionWatcherGuard {
    registry: Arc<ProjectInteractionRegistry>,
}

impl Drop for InteractionWatcherGuard {
    fn drop(&mut self) {
        self.registry.watcher_count.fetch_sub(1, Ordering::Relaxed);
    }
}

pub fn register_interaction_watcher(
    project_state_dir: impl AsRef<Path>,
) -> InteractionWatcherGuard {
    registry_for(project_state_dir.as_ref()).register_watcher()
}

pub fn pending_interactions_for_stream(project_state_dir: impl AsRef<Path>) -> Vec<Value> {
    registry_for(project_state_dir.as_ref()).list_pending(None)
}

impl InteractionRegistry {
    fn list_pending(&self, session_id: Option<&str>) -> Vec<Value> {
        self.requests
            .values()
            .filter(|request| request.get("status").and_then(Value::as_str) == Some("pending"))
            .filter(|request| {
                session_id.is_none_or(|session_id| {
                    request.get("sessionId").and_then(Value::as_str) == Some(session_id)
                })
            })
            .cloned()
            .collect()
    }

    fn find_pending_by_dedupe_key(&self, dedupe_key: &str) -> Option<Value> {
        self.requests
            .values()
            .find(|request| {
                request.get("status").and_then(Value::as_str) == Some("pending")
                    && request.get("dedupeKey").and_then(Value::as_str) == Some(dedupe_key)
            })
            .cloned()
    }

    fn settle(&mut self, id: &str, status: &str, response: Option<Value>) -> Option<Value> {
        let request = self.requests.get_mut(id)?;
        if request.get("status").and_then(Value::as_str) != Some("pending") {
            return None;
        }
        let object = request.as_object_mut()?;
        object.insert("status".into(), Value::String(status.to_owned()));
        object.insert("resolvedAt".into(), Value::String(now_iso()));
        if let Some(response) = response {
            object.insert("response".into(), response);
        }
        Some(Value::Object(object.clone()))
    }

    fn prune_settled(&mut self) {
        let cutoff = now_millis().saturating_sub(SETTLED_TTL_MS);
        self.requests.retain(|_, request| {
            if request.get("status").and_then(Value::as_str) == Some("pending") {
                return true;
            }
            let resolved = request
                .get("resolvedAt")
                .and_then(Value::as_str)
                .and_then(parse_iso_millis)
                .unwrap_or(u128::MAX);
            resolved > cutoff
        });
    }
}

#[derive(Debug)]
struct InteractionDisplay {
    title: String,
    message: String,
    summary: Option<String>,
}

fn summarize_interaction_for_display(input: &InteractionInput) -> InteractionDisplay {
    if input.interaction_type == "question" {
        let questions = question_records(&input.payload, input.summary.as_deref());
        if !questions.is_empty() {
            let prompts = questions
                .iter()
                .filter_map(|question| question.get("question").and_then(trimmed_value))
                .collect::<Vec<_>>();
            let message = questions
                .iter()
                .enumerate()
                .map(|(index, question)| format_question_text(question, index, questions.len()))
                .collect::<Vec<_>>()
                .join("\n\n");
            return InteractionDisplay {
                title: "AskUserQuestion".to_owned(),
                message,
                summary: Some(prompts.join("; ")).filter(|value| !value.is_empty()),
            };
        }
    }
    let summary = input.summary.as_deref().and_then(trimmed_str);
    let readable_summary = summary.filter(|summary| parse_object_string(summary).is_none());
    InteractionDisplay {
        title: format!("{} needs a response", input.session_id),
        message: readable_summary.map(str::to_owned).unwrap_or_else(|| {
            format!("Agent is waiting on a {} response.", input.interaction_type)
        }),
        summary: readable_summary.map(str::to_owned),
    }
}

fn question_records(payload: &Value, summary: Option<&str>) -> Vec<Map<String, Value>> {
    let payload_questions = question_records_from_source(payload.as_object())
        .into_iter()
        .filter(|question| question.get("question").and_then(trimmed_value).is_some())
        .collect::<Vec<_>>();
    if !payload_questions.is_empty() {
        return payload_questions;
    }
    parse_object_string(summary.unwrap_or(""))
        .as_ref()
        .map_or_else(Vec::new, |source| {
            question_records_from_source(Some(source))
                .into_iter()
                .filter(|question| question.get("question").and_then(trimmed_value).is_some())
                .collect()
        })
}

fn question_records_from_source(source: Option<&Map<String, Value>>) -> Vec<Map<String, Value>> {
    if let Some(questions) = source
        .and_then(|source| source.get("questions"))
        .and_then(Value::as_array)
    {
        return questions
            .iter()
            .filter_map(|question| question.as_object().cloned())
            .collect();
    }
    source.cloned().into_iter().collect()
}

fn format_question_text(question: &Map<String, Value>, index: usize, total: usize) -> String {
    let prompt = question
        .get("question")
        .and_then(trimmed_value)
        .unwrap_or_default();
    let prefix = if total > 1 {
        format!("{}. ", index + 1)
    } else {
        String::new()
    };
    let labels = question_option_labels(question);
    if labels.is_empty() {
        format!("{prefix}{prompt}")
    } else {
        format!("{prefix}{prompt}\nOptions: {}", labels.join("; "))
    }
}

fn question_option_labels(question: &Map<String, Value>) -> Vec<String> {
    question
        .get("options")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|option| {
            option
                .as_str()
                .and_then(trimmed_str)
                .map(str::to_owned)
                .or_else(|| {
                    option
                        .as_object()
                        .and_then(|option| option.get("label"))
                        .and_then(trimmed_value)
                })
        })
        .collect()
}

struct InteractionAlertInput {
    session_id: String,
    title: String,
    message: String,
    interaction_type: String,
    telemetry: bool,
    dedupe_key: String,
    display_context: InteractionDisplayContext,
    interaction: Value,
    unread: bool,
}

#[derive(Debug, Clone, Default)]
struct InteractionDisplayContext {
    worktree_path: Option<String>,
    worktree_name: Option<String>,
    branch: Option<String>,
}

fn contextualized_interaction_notification(
    context: &ProjectServiceRequestContext,
    input: InteractionAlertInput,
) -> NotificationWriteInput {
    let project_root = context.project_root().to_string_lossy().into_owned();
    let project_name = context
        .project_root()
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("aimux")
        .to_owned();
    let category = interaction_category(&input.interaction_type);
    let reason = if input.telemetry {
        "Tool prompt observed"
    } else {
        interaction_reason(&input.interaction_type)
    };
    let subject = session_alert_title(&input.session_id, &input.title);
    NotificationWriteInput {
        title: format!("[{category}] {project_name}"),
        body: alert_message_body(reason, &subject, &input.message),
        session_id: Some(input.session_id),
        kind: Some("interaction_request".to_owned()),
        project_name: Some(project_name),
        project_root: Some(project_root),
        worktree_path: input.display_context.worktree_path,
        worktree_name: input.display_context.worktree_name,
        branch: input.display_context.branch,
        category_label: Some(category.to_owned()),
        reason_label: Some(reason.to_owned()),
        dedupe_key: Some(input.dedupe_key),
        unread: input.unread,
        interaction: Some(input.interaction),
        ..NotificationWriteInput::default()
    }
}

fn resolve_session_display_context(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    worktree_path: Option<&str>,
) -> InteractionDisplayContext {
    let mut resolved = metadata_session_display_context(context, session_id);
    if let Some(worktree_path) = worktree_path.and_then(trimmed_str) {
        let worktree = worktree_display_context(context, worktree_path);
        resolved = merge_display_context(resolved, worktree);
    }
    resolved
}

fn metadata_session_display_context(
    context: &ProjectServiceRequestContext,
    session_id: &str,
) -> InteractionDisplayContext {
    let Some(desktop) = context.desktop_state.as_ref() else {
        return InteractionDisplayContext::default();
    };
    let session = ["sessions", "teammates"]
        .into_iter()
        .filter_map(|key| desktop.get(key).and_then(Value::as_array))
        .flat_map(|items| items.iter())
        .find(|item| item.get("id").and_then(Value::as_str) == Some(session_id));
    let Some(session) = session else {
        return InteractionDisplayContext::default();
    };
    let worktree_path = session.get("worktreePath").and_then(Value::as_str);
    let mut display = worktree_path
        .map(|path| worktree_display_context(context, path))
        .unwrap_or_default();
    if let Some(path) = worktree_path.and_then(trimmed_str) {
        display.worktree_path.get_or_insert_with(|| path.to_owned());
    }
    display
}

fn worktree_display_context(
    context: &ProjectServiceRequestContext,
    worktree_path: &str,
) -> InteractionDisplayContext {
    let path = trimmed_str(worktree_path).unwrap_or("");
    let Some(desktop) = context.desktop_state.as_ref() else {
        return InteractionDisplayContext {
            worktree_path: (!path.is_empty()).then(|| path.to_owned()),
            worktree_name: path_basename(path),
            branch: None,
        };
    };
    let worktree = desktop
        .get("worktrees")
        .and_then(Value::as_array)
        .and_then(|worktrees| {
            worktrees.iter().find(|worktree| {
                worktree.get("path").and_then(Value::as_str) == Some(path)
                    || worktree.get("resolvedPath").and_then(Value::as_str) == Some(path)
            })
        });
    if let Some(worktree) = worktree {
        return InteractionDisplayContext {
            worktree_path: worktree
                .get("path")
                .and_then(Value::as_str)
                .and_then(trimmed_str)
                .map(str::to_owned)
                .or_else(|| (!path.is_empty()).then(|| path.to_owned())),
            worktree_name: worktree
                .get("name")
                .and_then(Value::as_str)
                .and_then(trimmed_str)
                .map(str::to_owned)
                .or_else(|| path_basename(path)),
            branch: worktree
                .get("branch")
                .and_then(Value::as_str)
                .and_then(trimmed_str)
                .map(str::to_owned),
        };
    }
    InteractionDisplayContext {
        worktree_path: (!path.is_empty()).then(|| path.to_owned()),
        worktree_name: path_basename(path),
        branch: None,
    }
}

fn merge_display_context(
    base: InteractionDisplayContext,
    override_context: InteractionDisplayContext,
) -> InteractionDisplayContext {
    InteractionDisplayContext {
        worktree_path: override_context.worktree_path.or(base.worktree_path),
        worktree_name: override_context.worktree_name.or(base.worktree_name),
        branch: override_context.branch.or(base.branch),
    }
}

fn path_basename(path: &str) -> Option<String> {
    std::path::Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(trimmed_str)
        .map(str::to_owned)
}

fn session_alert_title(session_id: &str, fallback: &str) -> String {
    let subject = compact_session_id(session_id);
    let title = fallback.trim();
    if title.is_empty() {
        subject
    } else if title.contains(&subject) || title.contains(session_id) {
        title.replace(session_id, &subject)
    } else {
        format!("{subject}: {title}")
    }
}

fn compact_session_id(session_id: &str) -> String {
    let Some((base, suffix)) = session_id.rsplit_once('-') else {
        return session_id.to_owned();
    };
    if suffix.len() >= 4 && suffix.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        base.to_owned()
    } else {
        session_id.to_owned()
    }
}

fn alert_message_body(reason: &str, subject_title: &str, message: &str) -> String {
    let detail = message.trim();
    let subject = subject_title.trim();
    let parts = [reason, subject]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(": ");
    let comparable_detail = detail.trim_end_matches(['.', '!', '?']);
    if detail.is_empty() || comparable_detail == reason || detail == subject || detail == parts {
        return if parts.is_empty() {
            detail.to_owned()
        } else {
            parts
        };
    }
    format!("{parts} - {detail}")
}

fn interaction_category(interaction_type: &str) -> &'static str {
    match interaction_type {
        "permission" => "Permission",
        "exit_plan" => "Plan review",
        "question" => "Question",
        "input" => "Input",
        _ => "Interaction",
    }
}

fn interaction_reason(interaction_type: &str) -> &'static str {
    match interaction_type {
        "permission" => "Agent requested permission",
        "exit_plan" => "Agent requested plan review",
        "question" => "Agent asked a question",
        _ => "Agent requested input",
    }
}

fn clear_attention_if_no_pending(project_state_dir: &Path, request: &Value) {
    let Some(session_id) = request.get("sessionId").and_then(Value::as_str) else {
        return;
    };
    if session_id.is_empty()
        || !registry_for(project_state_dir)
            .list_pending(Some(session_id))
            .is_empty()
    {
        return;
    }
    let _ = set_session_attention(project_state_dir, session_id, "normal");
}

fn set_session_attention(
    project_state_dir: &Path,
    session_id: &str,
    attention: &str,
) -> Result<(), String> {
    update_session_metadata(project_state_dir, session_id, |current| {
        let mut derived = current
            .get("derived")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        derived.insert("attention".to_owned(), Value::String(attention.to_owned()));
        let mut current = current.as_object().cloned().unwrap_or_default();
        current.insert("derived".to_owned(), Value::Object(derived));
        Value::Object(current)
    })
    .map(|_| ())
}

fn parse_interaction_input(body: &Value) -> Option<InteractionInput> {
    let session_id = trimmed_field(body, "session")?;
    let interaction_type = trimmed_field(body, "type")?;
    if !matches!(
        interaction_type.as_str(),
        "permission" | "exit_plan" | "question" | "input"
    ) {
        return None;
    }
    Some(InteractionInput {
        session_id,
        interaction_type,
        payload: body.get("payload").cloned().unwrap_or_else(|| json!({})),
        summary: trimmed_field(body, "summary"),
        id: trimmed_field(body, "id"),
    })
}

fn is_plain_object(value: Option<&Value>) -> bool {
    value.is_none_or(|value| value.is_object())
}

fn is_plain_or_null(value: Option<&Value>) -> bool {
    value.is_none_or(|value| value.is_null() || value.is_object())
}

fn bounded_timeout_ms(raw: Option<i64>) -> u64 {
    raw.map(|value| value.clamp(MIN_WAIT_MS as i64, MAX_WAIT_MS as i64) as u64)
        .unwrap_or(DEFAULT_WAIT_MS)
}

fn registry_for(project_state_dir: &Path) -> Arc<ProjectInteractionRegistry> {
    let key = project_state_dir.to_string_lossy().into_owned();
    let registries = REGISTRIES.get_or_init(|| Mutex::new(BTreeMap::new()));
    let mut registries = registries.lock().expect("interaction registries poisoned");
    registries
        .entry(key)
        .or_insert_with(|| Arc::new(ProjectInteractionRegistry::default()))
        .clone()
}

fn interaction_dedupe_key(
    session_id: &str,
    interaction_type: &str,
    payload: &Value,
    summary: Option<&str>,
) -> String {
    let fingerprint_source = json!({
        "type": interaction_type,
        "summary": summary.unwrap_or(""),
        "payload": payload,
    });
    format!(
        "interaction:{session_id}:{interaction_type}:{}",
        stable_hash(&fingerprint_source)
    )
}

fn stable_hash(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    let json = serde_json::to_string(value).unwrap_or_default();
    let digest = Sha256::digest(json.as_bytes());
    base64_url_no_pad(&digest).chars().take(12).collect()
}

fn base64_url_no_pad(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0b0000_0011) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(TABLE[(((second & 0b0000_1111) << 2) | (third >> 6)) as usize] as char);
        }
        if chunk.len() > 2 {
            output.push(TABLE[(third & 0b0011_1111) as usize] as char);
        }
    }
    output
}

fn missing_interaction(id: &str) -> Value {
    json!({
        "id": id,
        "sessionId": "",
        "type": "permission",
        "payload": {},
        "status": "cancelled",
        "createdAt": now_iso(),
    })
}

fn parse_object_string(value: &str) -> Option<Map<String, Value>> {
    let trimmed = trimmed_str(value)?;
    if !trimmed.starts_with('{') {
        return None;
    }
    serde_json::from_str::<Value>(trimmed)
        .ok()
        .and_then(|value| value.as_object().cloned())
}

fn trimmed_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(trimmed_value)
}

fn trimmed_value(value: &Value) -> Option<String> {
    value.as_str().and_then(trimmed_str).map(str::to_owned)
}

fn trimmed_str(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn optional_json_string(value: Option<&str>) -> Value {
    value
        .and_then(trimmed_str)
        .map(|value| Value::String(value.to_owned()))
        .unwrap_or(Value::Null)
}

fn insert_optional_string(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value.and_then(trimmed_str) {
        map.insert(key.to_owned(), Value::String(value.to_owned()));
    }
}

fn unique_interaction_id() -> String {
    format!(
        "interaction-{}-{}",
        std::process::id(),
        INTERACTION_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    now.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn parse_iso_millis(value: &str) -> Option<u128> {
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i64>().ok()?;
    let month = date_parts.next()?.parse::<i64>().ok()?;
    let day = date_parts.next()?.parse::<i64>().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let time = time.strip_suffix('Z')?;
    let (hms, millis) = time.split_once('.').unwrap_or((time, "0"));
    let mut time_parts = hms.split(':');
    let hour = time_parts.next()?.parse::<i64>().ok()?;
    let minute = time_parts.next()?.parse::<i64>().ok()?;
    let second = time_parts.next()?.parse::<i64>().ok()?;
    if time_parts.next().is_some() || hour > 23 || minute > 59 || second > 59 || millis.len() > 3 {
        return None;
    }
    let mut millis = millis.parse::<u128>().ok()?;
    for _ in 0..(3 - value
        .split_once('.')
        .map_or(0, |(_, rest)| rest.trim_end_matches('Z').len()))
    {
        millis *= 10;
    }
    let days = days_from_civil(year, month, day)?;
    Some(
        (((days as u128 * 24 + hour as u128) * 60 + minute as u128) * 60 + second as u128) * 1000
            + millis,
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    (days >= 0).then_some(days)
}
