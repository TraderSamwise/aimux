use serde_json::{Map, Value, json};

const NOW: &str = "2026-01-01T00:00:00.000Z";

pub fn run_direct_thread_helper_contract_case(input: &Value) -> Value {
    let mut runtime = DirectThreadRuntime::default();
    let mut saved = Map::new();
    let mut result = Map::new();
    for operation in input["operations"].as_array().into_iter().flatten() {
        let route = operation["route"].as_str().unwrap_or_default();
        let body = resolve_body(operation.get("body").unwrap_or(&Value::Null), &saved);
        let response = match route {
            "/threads/open" => json!({ "thread": runtime.create_thread(&body) }),
            "/threads/send" => runtime.append_message_route(&body),
            "/threads/mark-seen" => {
                let thread_id = body["threadId"].as_str().unwrap_or_default();
                let session = body["session"].as_str().unwrap_or_default();
                json!({ "thread": runtime.mark_thread_seen(thread_id, session) })
            }
            "/threads/status" => {
                let thread_id = body["threadId"].as_str().unwrap_or_default();
                json!({ "thread": runtime.set_thread_status(thread_id, &body) })
            }
            other => panic!("unknown direct thread route: {other}"),
        };
        if let Some(save) = operation.get("save").and_then(Value::as_str) {
            saved.insert(save.to_owned(), response.clone());
        }
        match input["scenario"].as_str().unwrap_or_default() {
            "threads-open" => {
                result.insert("thread".into(), response["thread"].clone());
            }
            "threads-send" => {
                result.insert("thread".into(), response["thread"].clone());
                result.insert("message".into(), response["message"].clone());
                result.insert("messages".into(), Value::Array(runtime.messages.clone()));
            }
            "threads-mark-seen" | "threads-status" => {
                result.insert("thread".into(), response["thread"].clone());
            }
            _ => {}
        }
    }
    json!({
        "result": Value::Object(result),
        "exchange": runtime.exchange(),
    })
}

#[derive(Debug, Default)]
struct DirectThreadRuntime {
    next_id: usize,
    threads: Vec<Value>,
    messages: Vec<Value>,
}

impl DirectThreadRuntime {
    fn create_thread(&mut self, body: &Value) -> Value {
        let from = body["from"]
            .as_str()
            .or_else(|| body["createdBy"].as_str())
            .unwrap_or_default();
        let participants = unique_strings(
            std::iter::once(Value::String(from.to_owned())).chain(
                body["participants"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .cloned(),
            ),
        );
        let mut thread = Map::new();
        thread.insert("id".into(), Value::String(self.next_dynamic_id("thread")));
        thread.insert("title".into(), body["title"].clone());
        thread.insert(
            "kind".into(),
            body.get("kind")
                .cloned()
                .unwrap_or_else(|| Value::String("conversation".to_owned())),
        );
        thread.insert("createdAt".into(), Value::String(NOW.to_owned()));
        thread.insert("updatedAt".into(), Value::String(NOW.to_owned()));
        thread.insert("createdBy".into(), Value::String(from.to_owned()));
        thread.insert("participants".into(), Value::Array(participants));
        thread.insert(
            "status".into(),
            body.get("status")
                .cloned()
                .unwrap_or_else(|| Value::String("open".to_owned())),
        );
        for key in [
            "owner",
            "waitingOn",
            "worktreePath",
            "taskId",
            "lastMessageId",
            "unreadBy",
        ] {
            if let Some(value) = body.get(key)
                && !value.is_null()
            {
                thread.insert(key.to_owned(), value.clone());
            }
        }
        let thread = Value::Object(thread);
        self.upsert_thread(thread.clone());
        thread
    }

    fn append_message_route(&mut self, body: &Value) -> Value {
        let thread_id = body["threadId"].as_str().unwrap_or_default();
        let message = self.append_message(thread_id, body);
        let thread = self
            .threads
            .iter()
            .find(|thread| thread["id"].as_str() == Some(thread_id))
            .cloned()
            .unwrap_or(Value::Null);
        json!({
            "thread": thread,
            "message": message,
            "messages": self
                .messages
                .iter()
                .filter(|message| message["threadId"].as_str() == Some(thread_id))
                .cloned()
                .collect::<Vec<_>>(),
        })
    }

    fn append_message(&mut self, thread_id: &str, body: &Value) -> Value {
        let mut message = Map::new();
        message.insert("id".into(), Value::String(self.next_dynamic_id("msg")));
        message.insert("threadId".into(), Value::String(thread_id.to_owned()));
        message.insert("ts".into(), Value::String(NOW.to_owned()));
        message.insert("from".into(), body["from"].clone());
        message.insert("to".into(), body["to"].clone());
        message.insert(
            "kind".into(),
            body.get("kind")
                .cloned()
                .unwrap_or_else(|| Value::String("request".to_owned())),
        );
        message.insert("body".into(), body["body"].clone());
        let message = Value::Object(message);
        self.messages.push(message.clone());
        let message_id = message["id"].as_str().unwrap_or_default().to_owned();
        let from = message["from"].as_str().unwrap_or_default().to_owned();
        if let Some(thread) = self.thread_mut(thread_id) {
            thread["updatedAt"] = Value::String(NOW.to_owned());
            thread["lastMessageId"] = Value::String(message_id);
            let unread = thread["participants"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|participant| *participant != from)
                .map(|participant| Value::String(participant.to_owned()))
                .collect::<Vec<_>>();
            thread["unreadBy"] = Value::Array(unread);
        }
        message
    }

    fn mark_thread_seen(&mut self, thread_id: &str, session: &str) -> Value {
        if let Some(thread) = self.thread_mut(thread_id) {
            thread["updatedAt"] = Value::String(NOW.to_owned());
            let unread = thread["unreadBy"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|value| value.as_str() != Some(session))
                .cloned()
                .collect::<Vec<_>>();
            thread["unreadBy"] = Value::Array(unread);
            return thread.clone();
        }
        Value::Null
    }

    fn set_thread_status(&mut self, thread_id: &str, body: &Value) -> Value {
        if let Some(thread) = self.thread_mut(thread_id) {
            thread["updatedAt"] = Value::String(NOW.to_owned());
            thread["status"] = body["status"].clone();
            if let Some(owner) = body.get("owner")
                && !owner.is_null()
            {
                thread["owner"] = owner.clone();
            }
            if matches!(body["status"].as_str(), Some("done" | "abandoned")) {
                thread["waitingOn"] = Value::Array(Vec::new());
            } else if let Some(waiting_on) = body.get("waitingOn") {
                thread["waitingOn"] = waiting_on.clone();
            }
            return thread.clone();
        }
        Value::Null
    }

    fn exchange(&self) -> Value {
        json!({
            "version": 1,
            "generatedAt": NOW,
            "threads": self.threads,
            "messages": self.messages,
            "tasks": [],
            "handoffs": [],
            "reviews": [],
            "waits": self.waits(),
            "inbox": self.inbox(),
            "planRefs": [],
            "continuityRefs": [],
            "attachmentRefs": [],
        })
    }

    fn waits(&self) -> Vec<Value> {
        self.threads
            .iter()
            .filter(|thread| thread["status"].as_str() == Some("waiting"))
            .filter_map(|thread| {
                let waiting_on = thread["waitingOn"].as_array()?;
                if waiting_on.is_empty() {
                    return None;
                }
                let id = thread["id"].as_str()?;
                Some(json!({
                    "id": format!("wait:thread:{id}"),
                    "status": "waiting",
                    "subjectKind": "thread",
                    "subjectId": id,
                    "waitingOn": waiting_on,
                    "owner": thread.get("owner").cloned().unwrap_or(Value::Null),
                    "createdAt": NOW,
                    "updatedAt": NOW,
                }))
            })
            .collect()
    }

    fn inbox(&self) -> Vec<Value> {
        let mut items = Vec::new();
        for thread in &self.threads {
            if thread["status"].as_str() == Some("waiting") {
                for participant in thread["waitingOn"].as_array().into_iter().flatten() {
                    items.push(inbox_item(thread, participant, "waiting", 13));
                }
            } else {
                for participant in thread["unreadBy"].as_array().into_iter().flatten() {
                    items.push(inbox_item(thread, participant, "unread", 3));
                }
            }
        }
        items
    }

    fn next_dynamic_id(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}-{}", self.next_id)
    }

    fn upsert_thread(&mut self, thread: Value) {
        let id = thread["id"].as_str().unwrap_or_default();
        if let Some(existing) = self
            .threads
            .iter_mut()
            .find(|existing| existing["id"].as_str() == Some(id))
        {
            *existing = thread;
        } else {
            self.threads.push(thread);
        }
    }

    fn thread_mut(&mut self, thread_id: &str) -> Option<&mut Value> {
        self.threads
            .iter_mut()
            .find(|thread| thread["id"].as_str() == Some(thread_id))
    }
}

fn inbox_item(thread: &Value, participant: &Value, state: &str, urgency: i64) -> Value {
    let thread_id = thread["id"].as_str().unwrap_or_default();
    let participant_id = participant.as_str().unwrap_or_default();
    json!({
        "id": format!("inbox:{participant_id}:thread:{thread_id}"),
        "participantId": participant,
        "subjectKind": "thread",
        "subjectId": thread_id,
        "state": state,
        "urgency": urgency,
        "updatedAt": NOW,
    })
}

fn resolve_body(body: &Value, saved: &Map<String, Value>) -> Value {
    let Some(map) = body.as_object() else {
        return body.clone();
    };
    let mut resolved = Map::new();
    for (key, value) in map {
        if let Some(output_key) = key.strip_suffix("From") {
            resolved.insert(
                output_key.to_owned(),
                resolve_saved_path(saved, value.as_str().unwrap_or_default())
                    .unwrap_or(Value::Null),
            );
        } else {
            resolved.insert(key.clone(), value.clone());
        }
    }
    Value::Object(resolved)
}

fn resolve_saved_path(saved: &Map<String, Value>, path: &str) -> Option<Value> {
    let mut parts = path.split('.');
    let root = parts.next()?;
    let mut value = saved.get(root)?;
    for part in parts {
        value = value.get(part)?;
    }
    Some(value.clone())
}

fn unique_strings(values: impl Iterator<Item = Value>) -> Vec<Value> {
    let mut out = Vec::new();
    for value in values {
        let Some(text) = value
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
        else {
            continue;
        };
        if !out
            .iter()
            .any(|existing: &Value| existing.as_str() == Some(text))
        {
            out.push(Value::String(text.to_owned()));
        }
    }
    out
}
