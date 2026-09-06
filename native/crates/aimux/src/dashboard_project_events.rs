use crate::project_api_contract::event_names;
use serde_json::{Map, Value};
use std::fmt::{self, Display, Formatter};

pub const DEFAULT_PROJECT_EVENT_BUFFER_LIMIT: usize = 256 * 1024;

const DESKTOP_STATE_REFRESH_VIEWS: &[&str] = &[
    "desktop-state",
    "agents",
    "services",
    "worktrees",
    "coordination-worklist",
    "notifications",
    "tasks",
    "threads",
];

const COORDINATION_REFRESH_VIEWS: &[&str] =
    &["coordination-worklist", "notifications", "tasks", "threads"];
const PROJECT_REFRESH_VIEWS: &[&str] = &[
    "project-observability",
    "tasks",
    "notifications",
    "worktrees",
    "agents",
    "services",
];
const TOPOLOGY_REFRESH_VIEWS: &[&str] = &["topology", "agents", "services", "worktrees"];
const LIBRARY_REFRESH_VIEWS: &[&str] = &["library"];
const GRAVEYARD_REFRESH_VIEWS: &[&str] = &["graveyard", "agents", "worktrees"];

#[derive(Debug, Clone, PartialEq)]
pub enum DashboardProjectEvent {
    Ready(Map<String, Value>),
    ProjectUpdate(Map<String, Value>),
    Alert(Map<String, Value>),
}

impl DashboardProjectEvent {
    pub fn payload(&self) -> &Map<String, Value> {
        match self {
            Self::Ready(payload) | Self::ProjectUpdate(payload) | Self::Alert(payload) => payload,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectEventsSseError {
    limit: usize,
}

impl ProjectEventsSseError {
    pub fn limit(&self) -> usize {
        self.limit
    }
}

impl Display for ProjectEventsSseError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "project event SSE frame exceeded {} bytes",
            self.limit
        )
    }
}

impl std::error::Error for ProjectEventsSseError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectEventsSseDecoder {
    limit: usize,
    line: Vec<u8>,
    event_name: String,
    data: Vec<u8>,
}

impl Default for ProjectEventsSseDecoder {
    fn default() -> Self {
        Self::new(DEFAULT_PROJECT_EVENT_BUFFER_LIMIT)
    }
}

impl ProjectEventsSseDecoder {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            line: Vec::new(),
            event_name: "message".into(),
            data: Vec::new(),
        }
    }

    pub fn push_chunk(
        &mut self,
        chunk: &[u8],
    ) -> Result<Vec<DashboardProjectEvent>, ProjectEventsSseError> {
        let mut events = Vec::new();
        for byte in chunk {
            if *byte == b'\n' {
                if let Some(event) = self.process_line()? {
                    events.push(event);
                }
                continue;
            }
            if self.buffered_len() >= self.limit {
                return Err(self.overflow());
            }
            self.line.push(*byte);
        }
        Ok(events)
    }

    pub fn buffered_len(&self) -> usize {
        self.line.len() + self.event_name.len() + self.data.len()
    }

    fn process_line(&mut self) -> Result<Option<DashboardProjectEvent>, ProjectEventsSseError> {
        let mut line = std::mem::take(&mut self.line);
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.is_empty() {
            return Ok(self.dispatch_event());
        }
        if line.starts_with(b":") {
            return Ok(None);
        }

        let separator = line.iter().position(|byte| *byte == b':');
        let (field, mut value) = match separator {
            Some(index) => (&line[..index], &line[index + 1..]),
            None => (line.as_slice(), &[][..]),
        };
        if value.first() == Some(&b' ') {
            value = &value[1..];
        }
        match field {
            b"event" => {
                let name = String::from_utf8_lossy(value);
                self.event_name = if name.is_empty() {
                    "message".into()
                } else {
                    name.into_owned()
                };
            }
            b"data" => {
                let separator_len = usize::from(!self.data.is_empty());
                if self.buffered_len() + separator_len + value.len() > self.limit {
                    return Err(self.overflow());
                }
                if separator_len != 0 {
                    self.data.push(b'\n');
                }
                self.data.extend_from_slice(value);
            }
            _ => {}
        }
        Ok(None)
    }

    fn dispatch_event(&mut self) -> Option<DashboardProjectEvent> {
        let event_name = std::mem::replace(&mut self.event_name, "message".into());
        let data = std::mem::take(&mut self.data);
        if data.is_empty() {
            return None;
        }
        let Value::Object(payload) = serde_json::from_slice::<Value>(&data).ok()? else {
            return None;
        };
        match event_name.as_str() {
            event_names::READY => Some(DashboardProjectEvent::Ready(payload)),
            event_names::PROJECT_UPDATE => Some(DashboardProjectEvent::ProjectUpdate(payload)),
            event_names::ALERT => Some(DashboardProjectEvent::Alert(payload)),
            _ => None,
        }
    }

    fn overflow(&mut self) -> ProjectEventsSseError {
        self.line.clear();
        self.event_name.clear();
        self.event_name.push_str("message");
        self.data.clear();
        ProjectEventsSseError { limit: self.limit }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DashboardProjectRefreshState {
    refresh_pending: bool,
    refresh_in_flight: bool,
}

impl DashboardProjectRefreshState {
    pub fn observe(&mut self, event: &DashboardProjectEvent) {
        if event_requests_desktop_state(event) {
            self.refresh_pending = true;
        }
    }

    pub fn observe_all<'a>(&mut self, events: impl IntoIterator<Item = &'a DashboardProjectEvent>) {
        for event in events {
            self.observe(event);
        }
    }

    pub fn take_refresh_request(&mut self) -> bool {
        if self.refresh_in_flight || !self.refresh_pending {
            return false;
        }
        self.refresh_pending = false;
        self.refresh_in_flight = true;
        true
    }

    pub fn complete_refresh(&mut self) {
        self.refresh_in_flight = false;
    }

    pub fn reset(&mut self) {
        self.refresh_pending = false;
        self.refresh_in_flight = false;
    }

    pub fn refresh_pending(&self) -> bool {
        self.refresh_pending
    }

    pub fn refresh_in_flight(&self) -> bool {
        self.refresh_in_flight
    }
}

pub fn event_requests_desktop_state(event: &DashboardProjectEvent) -> bool {
    match event {
        DashboardProjectEvent::Ready(_) => true,
        DashboardProjectEvent::Alert(_) => false,
        DashboardProjectEvent::ProjectUpdate(payload) => payload
            .get("views")
            .and_then(Value::as_array)
            .is_some_and(|views| {
                views.iter().filter_map(Value::as_str).any(|view| {
                    DESKTOP_STATE_REFRESH_VIEWS
                        .iter()
                        .any(|candidate| candidate == &view)
                })
            }),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardProjectRefreshWork {
    DashboardModel,
    Coordination,
    Project,
    Topology,
    Library,
    Graveyard,
}

impl DashboardProjectRefreshWork {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DashboardModel => "dashboard-model",
            Self::Coordination => "coordination",
            Self::Project => "project",
            Self::Topology => "topology",
            Self::Library => "library",
            Self::Graveyard => "graveyard",
        }
    }
}

pub fn dashboard_project_refresh_work(
    views: &[String],
    active_screen: Option<&str>,
) -> Vec<DashboardProjectRefreshWork> {
    let mut work = Vec::new();
    if touches(views, DESKTOP_STATE_REFRESH_VIEWS) {
        work.push(DashboardProjectRefreshWork::DashboardModel);
    }
    if active_screen == Some("coordination") && touches(views, COORDINATION_REFRESH_VIEWS) {
        work.push(DashboardProjectRefreshWork::Coordination);
    }
    if active_screen == Some("project") && touches(views, PROJECT_REFRESH_VIEWS) {
        work.push(DashboardProjectRefreshWork::Project);
    }
    if active_screen == Some("topology") && touches(views, TOPOLOGY_REFRESH_VIEWS) {
        work.push(DashboardProjectRefreshWork::Topology);
    }
    if active_screen == Some("library") && touches(views, LIBRARY_REFRESH_VIEWS) {
        work.push(DashboardProjectRefreshWork::Library);
    }
    if active_screen == Some("graveyard") && touches(views, GRAVEYARD_REFRESH_VIEWS) {
        work.push(DashboardProjectRefreshWork::Graveyard);
    }
    work
}

pub fn should_render_after_project_event_refresh(
    work: &[DashboardProjectRefreshWork],
    applied_refresh: bool,
    lifecycle_current: bool,
) -> bool {
    if work.is_empty() || !applied_refresh || !lifecycle_current {
        return false;
    }
    true
}

pub fn dashboard_alert_footer_flash(mode: &str, event: &Map<String, Value>) -> Option<String> {
    if mode != "dashboard" {
        return None;
    }
    let kind = event.get("kind").and_then(Value::as_str)?;
    let title = event
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("undefined");
    let session_id = event
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("agent");
    match kind {
        "notification" => Some(format!("◌ {title}")),
        "needs_input" => Some(format!("◉ {session_id} needs input")),
        "next_step" => Some(format!("◉ {session_id} ready for next step")),
        "message_waiting" => Some(format!("✉ Message waiting → {session_id}")),
        "handoff_waiting" => Some(format!("⇢ Handoff waiting → {session_id}")),
        "task_assigned" => Some(format!("⧫ Task assigned → {session_id}")),
        "review_waiting" => Some(format!("◌ Review waiting → {session_id}")),
        "blocked" => Some(format!("⧗ {title}")),
        "task_done" => Some(format!("✓ {title}")),
        "task_failed" => Some(format!("✗ {title}")),
        _ => None,
    }
}

fn touches(views: &[String], candidates: &[&str]) -> bool {
    candidates
        .iter()
        .any(|candidate| views.iter().any(|view| view == candidate))
}
