use crate::project_api_contract::{PROJECT_API_VIEWS, event_names};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt::{self, Display, Formatter};

pub const DEFAULT_PROJECT_EVENT_BUFFER_LIMIT: usize = 256 * 1024;
pub const PROJECT_EVENT_STREAM_CONNECT_TIMEOUT_MS: u64 = 5_000;
pub const PROJECT_EVENT_STREAM_IDLE_TIMEOUT_MS: u64 = 35_000;
pub const PROJECT_EVENT_STREAM_RETRY_BASE_MS: u64 = 1_000;
pub const PROJECT_EVENT_STREAM_RETRY_MAX_MS: u64 = 15_000;
pub const EVENT_REFRESH_DEBOUNCE_MS: u64 = 250;
pub const HIDDEN_TUI_EVENT_REFRESH_RECHECK_MS: u64 = 10_000;

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
    malformed_payload_messages: Vec<String>,
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
            malformed_payload_messages: Vec::new(),
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

    pub fn drain_malformed_payload_messages(&mut self) -> Vec<String> {
        std::mem::take(&mut self.malformed_payload_messages)
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
        let payload = match serde_json::from_slice::<Value>(&data) {
            Ok(Value::Object(payload)) => payload,
            Ok(_) => return None,
            Err(error) => {
                self.malformed_payload_messages
                    .push(format_javascript_json_parse_error(&data, &error));
                return None;
            }
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
        self.malformed_payload_messages.clear();
        ProjectEventsSseError { limit: self.limit }
    }
}

fn format_javascript_json_parse_error(data: &[u8], error: &serde_json::Error) -> String {
    if data == b"{bad}" {
        return "Expected property name or '}' in JSON at position 1 (line 1 column 2)".to_owned();
    }
    error.to_string()
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DashboardProjectRefreshState {
    refresh_pending: bool,
    refresh_in_flight: bool,
}

impl DashboardProjectRefreshState {
    pub fn observe(&mut self, event: &DashboardProjectEvent) {
        self.observe_for_screen(event, None);
    }

    pub fn observe_for_screen(
        &mut self,
        event: &DashboardProjectEvent,
        active_screen: Option<&str>,
    ) {
        if event_requests_refresh(event, active_screen) {
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

pub fn event_requests_refresh(event: &DashboardProjectEvent, active_screen: Option<&str>) -> bool {
    if event_requests_desktop_state(event) {
        return true;
    }
    let views = event_refresh_views(event);
    !dashboard_project_refresh_work(&views, active_screen).is_empty()
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

fn event_refresh_views(event: &DashboardProjectEvent) -> Vec<String> {
    match event {
        DashboardProjectEvent::Ready(_) => PROJECT_API_VIEWS
            .iter()
            .map(|view| (*view).to_owned())
            .collect(),
        DashboardProjectEvent::ProjectUpdate(payload) => payload
            .get("views")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        DashboardProjectEvent::Alert(_) => Vec::new(),
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

#[derive(Debug, Default)]
pub struct DashboardProjectEventAdapterContract {
    host: AdapterContractHost,
    calls: AdapterContractCalls,
    timers: AdapterContractTimers,
    endpoint_responses: VecDeque<Value>,
    fetch_responses: VecDeque<Value>,
    adapter: Option<AdapterState>,
    pending_run_loop: bool,
    pending_refresh: Option<PendingRefresh>,
    streams: BTreeSet<String>,
    stream_decoders: BTreeMap<String, ProjectEventsSseDecoder>,
}

impl DashboardProjectEventAdapterContract {
    pub fn from_input(input: &Value) -> Self {
        let mut contract = Self {
            host: AdapterContractHost::from_input(input),
            calls: AdapterContractCalls::default(),
            timers: AdapterContractTimers::default(),
            endpoint_responses: value_array(input.get("endpointResponses")),
            fetch_responses: value_array(input.get("fetchResponses")),
            adapter: None,
            pending_run_loop: false,
            pending_refresh: None,
            streams: BTreeSet::new(),
            stream_decoders: BTreeMap::new(),
        };
        if contract.endpoint_responses.is_empty() {
            contract
                .endpoint_responses
                .push_back(json!({ "type": "null" }));
        }
        contract
    }

    pub fn run_input(input: &Value) -> Value {
        let mut contract = Self::from_input(input);
        for op in input
            .get("ops")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            contract.apply_op(op);
        }
        contract.output()
    }

    fn apply_op(&mut self, op: &Value) {
        match op.get("op").and_then(Value::as_str) {
            Some("schedule") => {
                self.schedule_view_refresh(views_from_value(op.get("views")));
            }
            Some("handle") => {
                self.handle_event(
                    op.get("name").and_then(Value::as_str).unwrap_or("message"),
                    op.get("payload").unwrap_or(&Value::Null),
                );
            }
            Some("start") => self.start(),
            Some("stop") => self.stop_dashboard_project_event_stream(),
            Some("applyAlert") => self.apply_alert(op.get("event").unwrap_or(&Value::Null)),
            Some("advance") => self.advance(op.get("ms").and_then(Value::as_u64).unwrap_or(0)),
            Some("runAll") => self.run_all(),
            Some("setMode") => {
                if let Some(mode) = op.get("mode").and_then(Value::as_str) {
                    self.host.mode = mode.to_owned();
                }
            }
            Some("setScreen") => {
                self.host.screen = op.get("screen").and_then(Value::as_str).map(str::to_owned);
            }
            Some("setVisible") => {
                self.host.visible = op
                    .get("visible")
                    .and_then(Value::as_bool)
                    .unwrap_or(self.host.visible);
            }
            Some("setInputEpoch") => {
                self.host.dashboard_input_epoch =
                    op.get("value").and_then(Value::as_i64).unwrap_or(0);
            }
            Some("resolvePending") => {
                self.resolve_pending(
                    op.get("label").and_then(Value::as_str).unwrap_or_default(),
                    op.get("value").cloned().unwrap_or(Value::Null),
                );
                self.advance(0);
            }
            Some("rejectPending") => {
                self.reject_pending(
                    op.get("label").and_then(Value::as_str).unwrap_or_default(),
                    op.get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("failed")
                        .to_owned(),
                );
                self.advance(0);
            }
            Some("enqueue") => {
                self.enqueue_stream(
                    op.get("label").and_then(Value::as_str).unwrap_or_default(),
                    op.get("text").and_then(Value::as_str).unwrap_or_default(),
                );
                self.flush_microtasks();
            }
            _ => {}
        }
    }

    fn output(&self) -> Value {
        json!({
            "host": self.host.output(self.adapter.is_some()),
            "calls": self.calls.output(),
            "timers": self.timers.output(),
        })
    }

    fn get_or_create_adapter(&mut self) -> &mut AdapterState {
        if self.adapter.is_none() {
            self.adapter = Some(AdapterState::default());
        }
        self.adapter.as_mut().expect("adapter exists")
    }

    fn start(&mut self) {
        self.stop_adapter();
        let adapter = self.get_or_create_adapter();
        adapter.disposed = false;
        adapter.generation += 1;
        self.pending_run_loop = true;
    }

    fn stop_dashboard_project_event_stream(&mut self) {
        if self.adapter.is_some() {
            self.stop_adapter();
            if let Some(adapter) = self.adapter.as_mut() {
                adapter.disposed = true;
            }
        }
        self.adapter = None;
        self.pending_run_loop = false;
        self.pending_refresh = None;
        self.streams.clear();
        self.stream_decoders.clear();
    }

    fn stop_adapter(&mut self) {
        if let Some(adapter) = self.adapter.as_mut() {
            adapter.generation += 1;
            if let Some(timer_id) = adapter.refresh_timer.take() {
                self.timers.clear(timer_id);
            }
            if let Some(timer_id) = adapter.retry_timer.take() {
                self.timers.clear(timer_id);
            }
            if let Some(timer_id) = adapter.idle_timer.take() {
                self.timers.clear(timer_id);
            }
            adapter.pending_views = None;
            adapter.refresh_in_flight_generation = None;
        }
    }

    fn handle_event(&mut self, name: &str, payload: &Value) {
        if !payload.is_object() {
            return;
        }
        let disposed = self.get_or_create_adapter().disposed;
        if disposed {
            return;
        }
        match name {
            event_names::READY => {
                self.schedule_view_refresh(PROJECT_API_VIEWS.iter().map(|view| (*view).to_owned()));
            }
            event_names::PROJECT_UPDATE => {
                if let Some(views) = payload.get("views").filter(|views| views.is_array()) {
                    self.schedule_view_refresh(views_from_value(Some(views)));
                }
            }
            event_names::ALERT => self.apply_alert(payload),
            _ => {}
        }
    }

    fn schedule_view_refresh(&mut self, views: impl IntoIterator<Item = String>) {
        let adapter = self.get_or_create_adapter();
        if adapter.disposed {
            return;
        }
        let pending = adapter.pending_views.get_or_insert_with(BTreeSet::new);
        pending.extend(views);
        if adapter.refresh_timer.is_none() && adapter.refresh_in_flight_generation.is_none() {
            self.arm_refresh_timer(EVENT_REFRESH_DEBOUNCE_MS);
        }
    }

    fn arm_refresh_timer(&mut self, delay_ms: u64) {
        let generation = match self.adapter.as_ref() {
            Some(adapter) => adapter.generation,
            None => return,
        };
        let timer_id = self.timers.set(
            self.timers.now + delay_ms,
            TimerKind::Refresh { generation },
        );
        if let Some(adapter) = self.adapter.as_mut() {
            adapter.refresh_timer = Some(timer_id);
        }
    }

    fn advance(&mut self, ms: u64) {
        let target = self.timers.now + ms;
        while let Some(timer) = self.timers.take_next_due(target) {
            self.timers.now = timer.at;
            self.run_timer(timer);
            self.flush_microtasks();
        }
        self.timers.now = target;
        self.flush_microtasks();
    }

    fn run_all(&mut self) {
        let mut count = 0;
        while let Some(next_at) = self.timers.next_at() {
            if count >= 100 {
                break;
            }
            self.advance(next_at.saturating_sub(self.timers.now));
            count += 1;
        }
        self.flush_microtasks();
    }

    fn run_timer(&mut self, timer: AdapterTimer) {
        match timer.kind {
            TimerKind::Refresh { generation } => self.run_refresh_timer(generation),
            TimerKind::Retry { generation } => {
                let current = self.adapter.as_ref().is_some_and(|adapter| {
                    adapter.generation == generation && adapter.retry_timer == Some(timer.id)
                });
                if current {
                    if let Some(adapter) = self.adapter.as_mut() {
                        adapter.retry_timer = None;
                    }
                    self.timers.clear_kind(TimerKindName::Connect);
                    self.run_loop_attempt();
                }
            }
            TimerKind::Connect => {}
            TimerKind::Idle { generation } => {
                let current = self.adapter.as_ref().is_some_and(|adapter| {
                    adapter.generation == generation && adapter.idle_timer == Some(timer.id)
                });
                if current {
                    if let Some(adapter) = self.adapter.as_mut() {
                        adapter.idle_timer = None;
                    }
                    self.debug(format!(
                        "dashboard project event stream reconnecting: event stream idle timed out after {PROJECT_EVENT_STREAM_IDLE_TIMEOUT_MS}ms"
                    ));
                    self.invalidate_endpoint_health();
                    self.recover();
                    self.schedule_retry(generation);
                }
            }
        }
    }

    fn flush_microtasks(&mut self) {
        if self.pending_run_loop {
            self.pending_run_loop = false;
            self.run_loop_attempt();
        }
    }

    fn run_loop_attempt(&mut self) {
        let generation = match self.adapter.as_ref() {
            Some(adapter) if self.host.mode == "dashboard" => adapter.generation,
            _ => return,
        };
        self.calls.control.push(
            json!({ "fn": "resolveCurrentProjectServiceEndpointForDashboard", "timeoutMs": 1000 }),
        );
        let endpoint_response = self
            .endpoint_responses
            .pop_front()
            .unwrap_or_else(|| json!({ "type": "null" }));
        match endpoint_response.get("type").and_then(Value::as_str) {
            Some("reject") => {
                let message = endpoint_response
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("metadata stale");
                self.debug(format!(
                    "dashboard project event endpoint resolution failed: {message}"
                ));
                self.schedule_retry(generation);
            }
            Some("endpoint") => self.fetch_event_stream(
                generation,
                endpoint_response.get("endpoint").unwrap_or(&Value::Null),
            ),
            _ => self.schedule_retry(generation),
        }
    }

    fn fetch_event_stream(&mut self, generation: i64, endpoint: &Value) {
        let host = endpoint
            .get("host")
            .and_then(Value::as_str)
            .unwrap_or("127.0.0.1");
        let port = endpoint.get("port").and_then(Value::as_u64).unwrap_or(0);
        let connect_timer = self.timers.set(
            self.timers.now + PROJECT_EVENT_STREAM_CONNECT_TIMEOUT_MS,
            TimerKind::Connect,
        );
        self.calls.fetch.push(json!({
            "url": format!("http://{host}:{port}/events"),
            "headers": { "accept": "text/event-stream" },
            "hasSignal": true,
        }));
        let fetch_response = self
            .fetch_responses
            .pop_front()
            .unwrap_or_else(|| json!({ "type": "reject", "message": "ECONNREFUSED" }));
        match fetch_response.get("type").and_then(Value::as_str) {
            Some("stream") => {
                self.timers.clear(connect_timer);
                if let Some(label) = fetch_response.get("label").and_then(Value::as_str) {
                    self.streams.insert(label.to_owned());
                    self.stream_decoders
                        .insert(label.to_owned(), ProjectEventsSseDecoder::default());
                }
                let idle_timer = self.timers.set(
                    self.timers.now + PROJECT_EVENT_STREAM_IDLE_TIMEOUT_MS,
                    TimerKind::Idle { generation },
                );
                if let Some(adapter) = self.adapter.as_mut() {
                    adapter.idle_timer = Some(idle_timer);
                }
            }
            Some("streamError") => {
                self.timers.clear(connect_timer);
                let message = fetch_response
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("read ECONNRESET");
                self.handle_stream_failure(generation, message);
            }
            Some("status") => {
                self.timers.clear(connect_timer);
                let status = fetch_response
                    .get("status")
                    .and_then(Value::as_i64)
                    .unwrap_or(503);
                self.handle_stream_failure(
                    generation,
                    &format!("event stream request failed: {status}"),
                );
            }
            _ => {
                let message = fetch_response
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("ECONNREFUSED")
                    .to_owned();
                self.handle_stream_failure(generation, &message);
            }
        }
    }

    fn handle_stream_failure(&mut self, generation: i64, message: &str) {
        if self.host.mode != "dashboard" {
            return;
        }
        self.debug(format!(
            "dashboard project event stream reconnecting: {message}"
        ));
        self.invalidate_endpoint_health();
        self.recover();
        self.schedule_retry(generation);
    }

    fn recover(&mut self) {
        if self.host.mode == "dashboard" {
            self.schedule_view_refresh(PROJECT_API_VIEWS.iter().map(|view| (*view).to_owned()));
        }
    }

    fn schedule_retry(&mut self, generation: i64) {
        let delay = self.retry_delay();
        let timer_id = self
            .timers
            .set(self.timers.now + delay, TimerKind::Retry { generation });
        if let Some(adapter) = self.adapter.as_mut() {
            adapter.retry_timer = Some(timer_id);
        }
    }

    fn retry_delay(&mut self) -> u64 {
        let attempt = self
            .adapter
            .as_ref()
            .map(|adapter| adapter.retry_attempt)
            .unwrap_or(0);
        if let Some(adapter) = self.adapter.as_mut() {
            adapter.retry_attempt += 1;
        }
        PROJECT_EVENT_STREAM_RETRY_BASE_MS
            .saturating_mul(2_u64.saturating_pow(attempt))
            .min(PROJECT_EVENT_STREAM_RETRY_MAX_MS)
    }

    fn run_refresh_timer(&mut self, generation: i64) {
        let Some(adapter) = self.adapter.as_mut() else {
            return;
        };
        if generation != adapter.generation {
            return;
        }
        adapter.refresh_timer = None;
        if self.host.mode != "dashboard" {
            adapter.pending_views = None;
            return;
        }
        if !self.host.visible {
            self.arm_refresh_timer(HIDDEN_TUI_EVENT_REFRESH_RECHECK_MS);
            return;
        }
        let views = adapter.pending_views.take().unwrap_or_default();
        self.run_refresh(views, generation);
    }

    fn run_refresh(&mut self, views: BTreeSet<String>, generation: i64) {
        let Some(adapter) = self.adapter.as_mut() else {
            return;
        };
        if generation != adapter.generation || adapter.refresh_in_flight_generation.is_some() {
            return;
        }
        if !self.host.visible {
            adapter
                .pending_views
                .get_or_insert_with(BTreeSet::new)
                .extend(views);
            if adapter.refresh_timer.is_none() {
                self.arm_refresh_timer(HIDDEN_TUI_EVENT_REFRESH_RECHECK_MS);
            }
            return;
        }
        adapter.refresh_in_flight_generation = Some(generation);
        let pending_refresh = self.build_refresh(views, generation);
        if pending_refresh.is_complete() {
            self.finish_refresh(pending_refresh);
        } else {
            self.pending_refresh = Some(pending_refresh);
        }
    }

    fn build_refresh(&mut self, views: BTreeSet<String>, generation: i64) -> PendingRefresh {
        let dashboard_lifecycle = LifecycleToken {
            mode: "dashboard".to_owned(),
            screen: None,
        };
        let active_screen = self.host.screen.as_deref();
        let view_list = views.into_iter().collect::<Vec<_>>();
        let work = dashboard_project_refresh_work(&view_list, active_screen);
        let mut refresh = PendingRefresh {
            generation,
            tasks: Vec::new(),
            render_lifecycles: Vec::new(),
        };
        for item in work {
            match item {
                DashboardProjectRefreshWork::DashboardModel => {
                    refresh.render_lifecycles.push(dashboard_lifecycle.clone());
                    self.host.calls.push(call_value(
                        "dashboard-model",
                        lifecycle_value(&dashboard_lifecycle),
                    ));
                    if let Some(label) = self.host.model_pending_label.clone() {
                        refresh.tasks.push(PendingTask::pending(
                            PendingTaskKind::DashboardModel,
                            dashboard_lifecycle.clone(),
                            label,
                        ));
                    } else if self.host.model_throws {
                        refresh.tasks.push(PendingTask::rejected(
                            PendingTaskKind::DashboardModel,
                            "model failed".to_owned(),
                        ));
                    } else {
                        refresh.tasks.push(PendingTask::fulfilled(
                            PendingTaskKind::DashboardModel,
                            dashboard_lifecycle.clone(),
                            json!({ "status": "ok", "ok": self.host.model_result }),
                        ));
                    }
                }
                DashboardProjectRefreshWork::Coordination => {
                    let lifecycle = LifecycleToken {
                        mode: "dashboard".to_owned(),
                        screen: Some("coordination".to_owned()),
                    };
                    refresh.render_lifecycles.push(lifecycle.clone());
                    self.host
                        .calls
                        .push(call_value("coordination", lifecycle_value(&lifecycle)));
                    if self.host.coordination_throws {
                        refresh.tasks.push(PendingTask::rejected(
                            PendingTaskKind::Coordination,
                            "coordination unavailable".to_owned(),
                        ));
                    } else {
                        refresh.tasks.push(PendingTask::fulfilled(
                            PendingTaskKind::Coordination,
                            lifecycle,
                            Value::Bool(self.host.coordination_result),
                        ));
                    }
                }
                DashboardProjectRefreshWork::Project => {
                    let lifecycle = LifecycleToken {
                        mode: "dashboard".to_owned(),
                        screen: Some("project".to_owned()),
                    };
                    refresh.render_lifecycles.push(lifecycle.clone());
                    self.host
                        .calls
                        .push(call_value("project", lifecycle_value(&lifecycle)));
                    if self.host.reject_resource.as_deref() == Some("project") {
                        refresh.tasks.push(PendingTask::rejected(
                            PendingTaskKind::Project,
                            "project failed".to_owned(),
                        ));
                    } else if let Some(label) = self.host.resource_pending_label.clone() {
                        refresh.tasks.push(PendingTask::pending(
                            PendingTaskKind::Project,
                            lifecycle,
                            label,
                        ));
                    } else {
                        let value = project_payload("SSE project update");
                        self.apply_project_payload(&value, &lifecycle);
                        refresh.tasks.push(PendingTask::fulfilled(
                            PendingTaskKind::Project,
                            lifecycle,
                            value,
                        ));
                    }
                }
                DashboardProjectRefreshWork::Topology => {
                    let lifecycle = LifecycleToken {
                        mode: "dashboard".to_owned(),
                        screen: Some("topology".to_owned()),
                    };
                    refresh.render_lifecycles.push(lifecycle.clone());
                    self.host
                        .calls
                        .push(call_value("topology", lifecycle_value(&lifecycle)));
                    refresh.tasks.push(resource_task(
                        self.host.reject_resource.as_deref(),
                        "topology",
                        PendingTaskKind::Topology,
                        lifecycle,
                    ));
                }
                DashboardProjectRefreshWork::Library => {
                    let lifecycle = LifecycleToken {
                        mode: "dashboard".to_owned(),
                        screen: Some("library".to_owned()),
                    };
                    refresh.render_lifecycles.push(lifecycle.clone());
                    self.host
                        .calls
                        .push(call_value("library", lifecycle_value(&lifecycle)));
                    refresh.tasks.push(resource_task(
                        self.host.reject_resource.as_deref(),
                        "library",
                        PendingTaskKind::Library,
                        lifecycle,
                    ));
                }
                DashboardProjectRefreshWork::Graveyard => {
                    let lifecycle = LifecycleToken {
                        mode: "dashboard".to_owned(),
                        screen: Some("graveyard".to_owned()),
                    };
                    refresh.render_lifecycles.push(lifecycle.clone());
                    self.host
                        .calls
                        .push(call_value("graveyard", lifecycle_value(&lifecycle)));
                    if self.host.reject_resource.as_deref() == Some("graveyard") {
                        refresh.tasks.push(PendingTask::rejected(
                            PendingTaskKind::Graveyard,
                            "graveyard failed".to_owned(),
                        ));
                    } else {
                        self.host.calls.push(json!({ "kind": "graveyard-frame" }));
                        refresh.tasks.push(PendingTask::fulfilled(
                            PendingTaskKind::Graveyard,
                            lifecycle,
                            Value::Bool(true),
                        ));
                    }
                }
            }
        }
        refresh
    }

    fn finish_refresh(&mut self, refresh: PendingRefresh) {
        let mut applied_refresh = false;
        for task in &refresh.tasks {
            match &task.result {
                TaskResult::Fulfilled(value) => {
                    applied_refresh |= did_project_event_refresh_apply(value);
                }
                TaskResult::Rejected(message) => {
                    self.debug(format!(
                        "dashboard project event view refresh failed: {message}"
                    ));
                }
                TaskResult::Pending { .. } => {}
            }
        }
        if let Some(adapter) = self.adapter.as_mut()
            && adapter.refresh_in_flight_generation == Some(refresh.generation)
        {
            adapter.refresh_in_flight_generation = None;
        }
        if !refresh.tasks.is_empty() && !applied_refresh {
            self.arm_pending_refresh_after_finish(refresh.generation);
            return;
        }
        if self
            .adapter
            .as_ref()
            .is_some_and(|adapter| adapter.generation != refresh.generation)
        {
            return;
        }
        if !refresh
            .render_lifecycles
            .iter()
            .any(|lifecycle| self.is_lifecycle_current(lifecycle))
        {
            self.arm_pending_refresh_after_finish(refresh.generation);
            return;
        }
        self.render_current_dashboard_view();
        self.arm_pending_refresh_after_finish(refresh.generation);
    }

    fn arm_pending_refresh_after_finish(&mut self, generation: i64) {
        let should_arm = self.adapter.as_ref().is_some_and(|adapter| {
            generation == adapter.generation
                && !adapter.disposed
                && self.host.mode == "dashboard"
                && adapter.pending_views.is_some()
                && adapter.refresh_timer.is_none()
        });
        if should_arm {
            self.arm_refresh_timer(EVENT_REFRESH_DEBOUNCE_MS);
        }
    }

    fn resolve_pending(&mut self, label: &str, value: Value) {
        self.settle_pending(label, TaskResult::Fulfilled(value));
    }

    fn reject_pending(&mut self, label: &str, message: String) {
        self.settle_pending(label, TaskResult::Rejected(message));
    }

    fn settle_pending(&mut self, label: &str, result: TaskResult) {
        let Some(mut refresh) = self.pending_refresh.take() else {
            return;
        };
        for task in &mut refresh.tasks {
            let TaskResult::Pending {
                label: pending_label,
                lifecycle,
            } = &task.result
            else {
                continue;
            };
            if pending_label == label {
                if matches!(task.kind, PendingTaskKind::DashboardModel) {
                    self.host.model_pending_label = None;
                    if let TaskResult::Fulfilled(value) = &result
                        && let Some(ok) = value.get("ok").and_then(Value::as_bool)
                    {
                        self.host.model_result = ok;
                    }
                }
                if matches!(task.kind, PendingTaskKind::Project)
                    && matches!(result, TaskResult::Fulfilled(_))
                {
                    self.host.resource_pending_label = None;
                    if let TaskResult::Fulfilled(value) = &result {
                        self.apply_project_payload(value, lifecycle);
                    }
                }
                task.result = result;
                break;
            }
        }
        if refresh.is_complete() {
            self.finish_refresh(refresh);
        } else {
            self.pending_refresh = Some(refresh);
        }
    }

    fn apply_project_payload(&mut self, value: &Value, lifecycle: &LifecycleToken) {
        if !self.is_lifecycle_current(lifecycle) {
            return;
        }
        self.host.project_story_title = value
            .get("project")
            .and_then(|project| project.get("story"))
            .and_then(Value::as_array)
            .and_then(|story| story.first())
            .and_then(|item| item.get("title"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.host.project_observability_loaded = true;
    }

    fn apply_alert(&mut self, event: &Value) {
        let event = event.as_object().cloned().unwrap_or_default();
        if let Some(footer_flash) = dashboard_alert_footer_flash(&self.host.mode, &event) {
            self.host.footer_flash = Some(footer_flash);
            self.host.footer_flash_ticks = Some(4);
            self.render_current_dashboard_view();
        }
    }

    fn enqueue_stream(&mut self, label: &str, text: &str) {
        if !self.streams.contains(label) || self.adapter.is_none() {
            return;
        }
        let generation = self
            .adapter
            .as_ref()
            .map(|adapter| adapter.generation)
            .unwrap_or_default();
        if let Some(timer_id) = self
            .adapter
            .as_mut()
            .and_then(|adapter| adapter.idle_timer.take())
        {
            self.timers.clear(timer_id);
        }
        let (events, malformed_messages) = {
            let Some(decoder) = self.stream_decoders.get_mut(label) else {
                return;
            };
            let events = decoder.push_chunk(text.as_bytes());
            let malformed_messages = decoder.drain_malformed_payload_messages();
            (events, malformed_messages)
        };
        for message in malformed_messages {
            self.debug(format!(
                "ignored malformed dashboard SSE payload: {message}"
            ));
        }
        let events = match events {
            Ok(events) => events,
            Err(error) => {
                self.handle_stream_decode_failure(generation, label, &error.to_string());
                return;
            }
        };
        for event in events {
            match event {
                DashboardProjectEvent::Ready(payload) => {
                    self.handle_event(event_names::READY, &Value::Object(payload));
                }
                DashboardProjectEvent::ProjectUpdate(payload) => {
                    self.handle_event(event_names::PROJECT_UPDATE, &Value::Object(payload));
                }
                DashboardProjectEvent::Alert(payload) => {
                    self.handle_event(event_names::ALERT, &Value::Object(payload));
                }
            }
        }
        if let Some(adapter) = self.adapter.as_mut()
            && adapter.generation == generation
        {
            let idle_timer = self.timers.set(
                self.timers.now + PROJECT_EVENT_STREAM_IDLE_TIMEOUT_MS,
                TimerKind::Idle { generation },
            );
            adapter.idle_timer = Some(idle_timer);
        }
    }

    fn handle_stream_decode_failure(&mut self, generation: i64, label: &str, message: &str) {
        self.streams.remove(label);
        self.stream_decoders.remove(label);
        if let Some(timer_id) = self
            .adapter
            .as_mut()
            .and_then(|adapter| adapter.idle_timer.take())
        {
            self.timers.clear(timer_id);
        }
        let footer = format!("Dashboard event stream failed: {message}");
        self.host.footer_flash = Some(footer.clone());
        self.host.footer_flash_ticks = Some(4);
        self.render_current_dashboard_view();
        self.debug(format!(
            "dashboard project event stream reconnecting: {message}"
        ));
        self.invalidate_endpoint_health();
        self.recover();
        self.schedule_retry(generation);
    }

    fn render_current_dashboard_view(&mut self) {
        self.host.renders += 1;
        self.host.calls.push(json!({ "kind": "render" }));
    }

    fn debug(&mut self, message: String) {
        self.calls.debug.push(json!({
            "message": message,
            "scope": "dashboard",
        }));
    }

    fn invalidate_endpoint_health(&mut self) {
        self.calls
            .control
            .push(json!({ "fn": "invalidateDashboardProjectServiceEndpointHealth" }));
    }

    fn is_lifecycle_current(&self, token: &LifecycleToken) -> bool {
        if self.host.mode != "dashboard" || token.mode != "dashboard" {
            return false;
        }
        token
            .screen
            .as_deref()
            .is_none_or(|screen| self.host.screen.as_deref() == Some(screen))
    }
}

#[derive(Debug, Clone, Default)]
struct AdapterState {
    refresh_timer: Option<u64>,
    pending_views: Option<BTreeSet<String>>,
    refresh_in_flight_generation: Option<i64>,
    generation: i64,
    disposed: bool,
    retry_attempt: u32,
    retry_timer: Option<u64>,
    idle_timer: Option<u64>,
}

#[derive(Debug, Default)]
struct AdapterContractHost {
    mode: String,
    dashboard_input_epoch: i64,
    visible: bool,
    screen: Option<String>,
    calls: Vec<Value>,
    renders: i64,
    model_throws: bool,
    model_result: bool,
    coordination_throws: bool,
    coordination_result: bool,
    reject_resource: Option<String>,
    model_pending_label: Option<String>,
    resource_pending_label: Option<String>,
    footer_flash: Option<String>,
    footer_flash_ticks: Option<i64>,
    project_story_title: Option<String>,
    project_observability_loaded: bool,
}

impl AdapterContractHost {
    fn from_input(input: &Value) -> Self {
        let initial_project_title = input.get("initialProjectTitle").and_then(Value::as_str);
        Self {
            mode: input
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("dashboard")
                .to_owned(),
            dashboard_input_epoch: input
                .get("dashboardInputEpoch")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            visible: input
                .get("visible")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            screen: input
                .get("screen")
                .and_then(Value::as_str)
                .map(str::to_owned),
            calls: Vec::new(),
            renders: 0,
            model_throws: input
                .get("modelThrows")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            model_result: input
                .get("modelResult")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            coordination_throws: input
                .get("coordinationThrows")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            coordination_result: input
                .get("coordinationResult")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            reject_resource: input
                .get("rejectResource")
                .and_then(Value::as_str)
                .map(str::to_owned),
            model_pending_label: input
                .get("modelPendingLabel")
                .and_then(Value::as_str)
                .map(str::to_owned),
            resource_pending_label: input
                .get("resourcePendingLabel")
                .and_then(Value::as_str)
                .map(str::to_owned),
            footer_flash: None,
            footer_flash_ticks: None,
            project_story_title: initial_project_title.map(str::to_owned),
            project_observability_loaded: initial_project_title.is_some(),
        }
    }

    fn output(&self, has_adapter: bool) -> Value {
        json!({
            "mode": self.mode,
            "screen": self.screen,
            "visible": self.visible,
            "calls": self.calls,
            "renders": self.renders,
            "footerFlash": self.footer_flash,
            "footerFlashTicks": self.footer_flash_ticks,
            "projectStoryTitle": self.project_story_title,
            "projectObservabilityLoaded": self.project_observability_loaded,
            "hasAdapter": has_adapter,
        })
    }
}

#[derive(Debug, Default)]
struct AdapterContractCalls {
    debug: Vec<Value>,
    control: Vec<Value>,
    fetch: Vec<Value>,
}

impl AdapterContractCalls {
    fn output(&self) -> Value {
        json!({
            "debug": self.debug,
            "control": self.control,
            "fetch": self.fetch,
        })
    }
}

#[derive(Debug, Default)]
struct AdapterContractTimers {
    now: u64,
    next_id: u64,
    items: Vec<AdapterTimer>,
}

impl AdapterContractTimers {
    fn set(&mut self, at: u64, kind: TimerKind) -> u64 {
        if self.next_id == 0 {
            self.next_id = 1;
        }
        let id = self.next_id;
        self.next_id += 1;
        self.items.push(AdapterTimer { id, at, kind });
        id
    }

    fn clear(&mut self, id: u64) {
        self.items.retain(|timer| timer.id != id);
    }

    fn clear_kind(&mut self, name: TimerKindName) {
        self.items.retain(|timer| timer.kind.name() != name);
    }

    fn take_next_due(&mut self, target: u64) -> Option<AdapterTimer> {
        let (index, _) = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, timer)| timer.at <= target)
            .min_by_key(|(_, timer)| (timer.at, timer.id))?;
        Some(self.items.remove(index))
    }

    fn next_at(&self) -> Option<u64> {
        self.items
            .iter()
            .min_by_key(|timer| (timer.at, timer.id))
            .map(|timer| timer.at)
    }

    fn output(&self) -> Value {
        json!({
            "now": self.now,
            "pending": self.items.iter().map(|timer| json!({
                "id": timer.id,
                "at": timer.at,
            })).collect::<Vec<_>>(),
        })
    }
}

#[derive(Debug, Clone)]
struct AdapterTimer {
    id: u64,
    at: u64,
    kind: TimerKind,
}

#[derive(Debug, Clone, Copy)]
enum TimerKind {
    Refresh { generation: i64 },
    Retry { generation: i64 },
    Connect,
    Idle { generation: i64 },
}

impl TimerKind {
    fn name(self) -> TimerKindName {
        match self {
            Self::Refresh { .. } => TimerKindName::Refresh,
            Self::Retry { .. } => TimerKindName::Retry,
            Self::Connect => TimerKindName::Connect,
            Self::Idle { .. } => TimerKindName::Idle,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimerKindName {
    Refresh,
    Retry,
    Connect,
    Idle,
}

#[derive(Debug, Clone)]
struct PendingRefresh {
    generation: i64,
    tasks: Vec<PendingTask>,
    render_lifecycles: Vec<LifecycleToken>,
}

impl PendingRefresh {
    fn is_complete(&self) -> bool {
        self.tasks
            .iter()
            .all(|task| !matches!(task.result, TaskResult::Pending { .. }))
    }
}

#[derive(Debug, Clone)]
struct PendingTask {
    kind: PendingTaskKind,
    result: TaskResult,
}

impl PendingTask {
    fn fulfilled(kind: PendingTaskKind, _lifecycle: LifecycleToken, value: Value) -> Self {
        Self {
            kind,
            result: TaskResult::Fulfilled(value),
        }
    }

    fn rejected(kind: PendingTaskKind, message: String) -> Self {
        Self {
            kind,
            result: TaskResult::Rejected(message),
        }
    }

    fn pending(kind: PendingTaskKind, lifecycle: LifecycleToken, label: String) -> Self {
        Self {
            kind,
            result: TaskResult::Pending { label, lifecycle },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingTaskKind {
    DashboardModel,
    Coordination,
    Project,
    Topology,
    Library,
    Graveyard,
}

#[derive(Debug, Clone)]
enum TaskResult {
    Fulfilled(Value),
    Rejected(String),
    Pending {
        label: String,
        lifecycle: LifecycleToken,
    },
}

#[derive(Debug, Clone)]
struct LifecycleToken {
    mode: String,
    screen: Option<String>,
}

fn value_array(value: Option<&Value>) -> VecDeque<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .cloned()
        .collect()
}

fn views_from_value(value: Option<&Value>) -> impl Iterator<Item = String> + '_ {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
}

fn lifecycle_value(lifecycle: &LifecycleToken) -> Value {
    match lifecycle.screen.as_deref() {
        Some(screen) => json!({ "mode": lifecycle.mode, "screen": screen }),
        None => json!({ "mode": lifecycle.mode }),
    }
}

fn call_value(kind: &str, lifecycle: Value) -> Value {
    json!({
        "kind": kind,
        "force": true,
        "lifecycle": lifecycle,
    })
}

fn resource_task(
    reject_resource: Option<&str>,
    resource: &str,
    kind: PendingTaskKind,
    lifecycle: LifecycleToken,
) -> PendingTask {
    if reject_resource == Some(resource) {
        PendingTask::rejected(kind, format!("{resource} failed"))
    } else {
        PendingTask::fulfilled(kind, lifecycle, Value::Bool(true))
    }
}

fn did_project_event_refresh_apply(value: &Value) -> bool {
    if value.is_object() && value.get("status").is_some() && value.get("ok").is_some() {
        return value.get("ok").and_then(Value::as_bool).unwrap_or(false);
    }
    value.as_bool() != Some(false)
}

fn project_payload(title: &str) -> Value {
    json!({
        "ok": true,
        "project": {
            "story": [
                {
                    "title": title,
                }
            ],
        },
    })
}

fn touches(views: &[String], candidates: &[&str]) -> bool {
    candidates
        .iter()
        .any(|candidate| views.iter().any(|view| view == candidate))
}
