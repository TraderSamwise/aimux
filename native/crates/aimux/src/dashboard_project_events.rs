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
