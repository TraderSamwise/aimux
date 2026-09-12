use crate::daemon::access::{build_hosted_daemon_route_context, resolve_hosted_operator_stream};
use crate::daemon::http::{DaemonResponseBody, PreparedDaemonResponse, prepare_daemon_response};
use crate::daemon::json::ProjectEventStreamTarget;
use crate::daemon::listener::{
    DaemonRequestBodyLimit, DaemonRequestHead, DaemonRequestMetadata,
    handle_daemon_stream_with_metadata_and_interceptor_and_body_limit, prepared_response_bytes,
};
use crate::daemon::router::{DaemonRouteRuntime, route_daemon_request};
use crate::daemon::routing::DaemonRouteUrl;
use crate::daemon::server::DaemonHttpRequest;
use crate::daemon::stream::{
    HostAgentStreamError, HostAgentStreamRequestOptions, ProjectEventStreamChunk,
    open_project_event_stream_from_url,
};
use crate::hosted_audit::{HostedAuditRecord, HostedAuditStore, HostedPromptRecord, hash_prompt};
use crate::hosted_auth::{authenticate_hosted, strip_trusted_headers};
use crate::hosted_config::{HostedConfig, validate_hosted_startup};
use crate::hosted_events::{
    HostedDevicesStore, HostedEvent, HostedEventDelivery, SeenDeviceInput, client_address,
};
use crate::hosted_lockdown::HostedLockdownStore;
use crate::hosted_outbox::HostedOutboxStore;
use crate::hosted_principals::{
    HostedGrant, HostedPrincipal, HostedPrincipalsStore, principal_has_grant,
};
use crate::hosted_rate_limit::{HostedLimitOutcome, HostedRateLimitOptions, HostedRateLimiter};
use crate::paths::PathResolver;
use crate::project_api_contract::routes as project_routes;
use crate::proxy_project_binding::{is_binary_project_route, parse_proxy_target};
use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::Write;
use std::net::TcpListener;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_AUDIT_PROMPT_CHARS: usize = 1_024;
const MAX_AUDIT_FIELD_CHARS: usize = 256;
const PEER_BUDGET_MULTIPLIER: f64 = 4.0;
const OUTBOX_INTERVAL_MS: u64 = 5_000;
const PRUNE_INTERVAL_MS: u64 = 300_000;
const PRUNE_IDLE_MS: f64 = 300_000.0;
const SERVABLE_BINARY_TYPES: &[&str] = &["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_STREAMS_PER_PRINCIPAL: usize = 2;
const STREAM_MAX_LIFETIME_MS: u64 = 600_000;
const STREAM_IDLE_TIMEOUT_MS: u64 = 120_000;
const STREAM_MAX_BYTES: usize = 64 * 1024 * 1024;
const STREAM_REAUTH_INTERVAL_MS: u64 = 5_000;
const AUTH_FAILURE_WINDOW_MS: u128 = 60_000;
const AUTH_FAILURE_DELIVERY_MAX: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostedStreamLimits {
    pub max_per_principal: usize,
    pub max_lifetime_ms: u64,
    pub idle_timeout_ms: u64,
    pub max_bytes: usize,
    pub reauth_interval_ms: u64,
}

impl Default for HostedStreamLimits {
    fn default() -> Self {
        Self {
            max_per_principal: MAX_STREAMS_PER_PRINCIPAL,
            max_lifetime_ms: STREAM_MAX_LIFETIME_MS,
            idle_timeout_ms: STREAM_IDLE_TIMEOUT_MS,
            max_bytes: STREAM_MAX_BYTES,
            reauth_interval_ms: STREAM_REAUTH_INTERVAL_MS,
        }
    }
}

pub struct HostedServerState {
    config: HostedConfig,
    principals: HostedPrincipalsStore,
    audit: HostedAuditStore,
    devices: HostedDevicesStore,
    lockdown: HostedLockdownStore,
    outbox: HostedOutboxStore,
    outbox_drain: Arc<HostedOutboxDrainSignal>,
    outbox_drain_worker: Mutex<Option<JoinHandle<()>>>,
    limiter: HostedRateLimiter,
    peer_limiter: HostedRateLimiter,
    delivery: Arc<Mutex<HostedEventDelivery>>,
    streams_by_principal: Mutex<BTreeMap<String, usize>>,
    stream_limits: HostedStreamLimits,
    auth_failure_throttle: Mutex<AuthFailureThrottle>,
}

impl HostedServerState {
    pub fn with_resolver(config: HostedConfig, resolver: PathResolver) -> Self {
        Self::with_resolver_and_stream_limits_and_delivery(
            config.clone(),
            resolver,
            HostedStreamLimits::default(),
            HostedEventDelivery::new_from_hosted_config(&config),
        )
    }

    pub fn with_resolver_and_stream_limits(
        config: HostedConfig,
        resolver: PathResolver,
        stream_limits: HostedStreamLimits,
    ) -> Self {
        Self::with_resolver_and_stream_limits_and_delivery(
            config.clone(),
            resolver,
            stream_limits,
            HostedEventDelivery::new_from_hosted_config(&config),
        )
    }

    pub fn with_resolver_and_delivery(
        config: HostedConfig,
        resolver: PathResolver,
        delivery: HostedEventDelivery,
    ) -> Self {
        Self::with_resolver_and_stream_limits_and_delivery(
            config,
            resolver,
            HostedStreamLimits::default(),
            delivery,
        )
    }

    fn with_resolver_and_stream_limits_and_delivery(
        config: HostedConfig,
        resolver: PathResolver,
        stream_limits: HostedStreamLimits,
        delivery: HostedEventDelivery,
    ) -> Self {
        let limiter = HostedRateLimiter::new(HostedRateLimitOptions {
            requests_per_minute: config.rate_limit.requests_per_minute as f64,
            max_concurrent: config.rate_limit.max_concurrent,
            bytes_per_minute: config.rate_limit.bytes_per_minute as f64,
        });
        let peer_limiter = HostedRateLimiter::new(HostedRateLimitOptions {
            requests_per_minute: config.rate_limit.requests_per_minute as f64
                * PEER_BUDGET_MULTIPLIER,
            max_concurrent: config.rate_limit.max_concurrent * PEER_BUDGET_MULTIPLIER as i64,
            bytes_per_minute: config.rate_limit.bytes_per_minute as f64 * PEER_BUDGET_MULTIPLIER,
        });
        let delivery = Arc::new(Mutex::new(delivery));
        let outbox = HostedOutboxStore::with_resolver(resolver.clone());
        let outbox_drain = Arc::new(HostedOutboxDrainSignal::default());
        let outbox_drain_worker = spawn_hosted_outbox_drain_background(
            outbox.clone(),
            Arc::clone(&delivery),
            Arc::clone(&outbox_drain),
            Duration::from_millis(OUTBOX_INTERVAL_MS),
        );
        Self {
            delivery,
            config,
            principals: HostedPrincipalsStore::with_resolver(resolver.clone()),
            audit: HostedAuditStore::with_resolver(resolver.clone()),
            devices: HostedDevicesStore::with_resolver(resolver.clone()),
            lockdown: HostedLockdownStore::with_resolver(resolver.clone()),
            outbox,
            outbox_drain,
            outbox_drain_worker: Mutex::new(Some(outbox_drain_worker)),
            limiter,
            peer_limiter,
            streams_by_principal: Mutex::new(BTreeMap::new()),
            stream_limits,
            auth_failure_throttle: Mutex::new(AuthFailureThrottle::default()),
        }
    }

    pub fn config(&self) -> &HostedConfig {
        &self.config
    }

    fn prune(&self) {
        self.limiter.prune(PRUNE_IDLE_MS);
        self.peer_limiter.prune(PRUNE_IDLE_MS);
        self.audit
            .prune(self.config.retention_days, unix_millis(SystemTime::now()));
        self.devices
            .prune_devices(self.config.retention_days, unix_millis(SystemTime::now()));
    }

    fn spool_delivery_event(&self, event: &HostedEvent) {
        self.outbox.spool_event(event);
        self.outbox_drain.signal();
    }

    fn enqueue_delivery_async(&self, event: HostedEvent) {
        let delivery = Arc::clone(&self.delivery);
        let _ = thread::Builder::new()
            .name("aimux-hosted-event-delivery".to_owned())
            .spawn(move || {
                if let Ok(mut delivery) = delivery.lock() {
                    delivery.enqueue(event);
                }
            });
    }

    fn should_deliver_auth_failure(&self, key: &str) -> bool {
        let Ok(mut throttle) = self.auth_failure_throttle.lock() else {
            return false;
        };
        throttle.should_deliver(key, unix_millis(SystemTime::now()))
    }

    fn acquire_stream(&self, principal_id: &str) -> bool {
        let Ok(mut streams) = self.streams_by_principal.lock() else {
            return false;
        };
        let open = streams.get(principal_id).copied().unwrap_or(0);
        if open >= self.stream_limits.max_per_principal {
            return false;
        }
        streams.insert(principal_id.to_owned(), open + 1);
        true
    }

    fn release_stream(&self, principal_id: &str) {
        let Ok(mut streams) = self.streams_by_principal.lock() else {
            return;
        };
        let open = streams
            .get(principal_id)
            .copied()
            .unwrap_or(1)
            .saturating_sub(1);
        if open == 0 {
            streams.remove(principal_id);
        } else {
            streams.insert(principal_id.to_owned(), open);
        }
    }
}

impl Drop for HostedServerState {
    fn drop(&mut self) {
        self.outbox_drain.stop();
        if let Ok(mut worker) = self.outbox_drain_worker.lock()
            && let Some(worker) = worker.take()
        {
            let _ = worker.join();
        }
        let _ = drain_hosted_outbox(&self.outbox, &self.delivery);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostedOutboxDrainResult {
    Empty,
    Delivered(usize),
    Failed,
}

#[derive(Debug, Default)]
struct HostedOutboxDrainSignal {
    state: Mutex<HostedOutboxDrainState>,
    changed: Condvar,
}

#[derive(Debug, Default)]
struct HostedOutboxDrainState {
    pending: bool,
    stopped: bool,
}

impl HostedOutboxDrainSignal {
    fn signal(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.pending = true;
        self.changed.notify_one();
    }

    fn stop(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.stopped = true;
        self.changed.notify_all();
    }

    fn wait_for_next_run(&self, backstop: Duration) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.stopped {
            return false;
        }
        if !state.pending {
            let waited = self
                .changed
                .wait_timeout(state, backstop)
                .unwrap_or_else(|error| error.into_inner());
            state = waited.0;
        }
        if state.stopped {
            return false;
        }
        state.pending = false;
        true
    }
}

fn drain_hosted_outbox(
    outbox: &HostedOutboxStore,
    delivery: &Arc<Mutex<HostedEventDelivery>>,
) -> HostedOutboxDrainResult {
    let events = match outbox.try_drain_outbox() {
        Ok(events) => events,
        Err(error) => {
            crate::debug_logging::log_lifecycle_always(
                "hosted outbox drain failed",
                "hosted-outbox",
                Some(json!({ "error": error.to_string() })),
            );
            return HostedOutboxDrainResult::Failed;
        }
    };
    if events.is_empty() {
        return HostedOutboxDrainResult::Empty;
    }
    let event_count = events.len();
    match delivery.lock() {
        Ok(mut delivery) => {
            for event in events {
                delivery.enqueue(event);
            }
            HostedOutboxDrainResult::Delivered(event_count)
        }
        Err(error) => {
            respool_drained_events(outbox, &events, &error.to_string());
            HostedOutboxDrainResult::Failed
        }
    }
}

fn respool_drained_events(outbox: &HostedOutboxStore, events: &[HostedEvent], error: &str) {
    crate::debug_logging::log_lifecycle_always(
        "hosted outbox delivery handoff failed",
        "hosted-outbox",
        Some(json!({
            "error": error,
            "eventCount": events.len(),
        })),
    );
    for event in events {
        outbox.spool_event(event);
    }
}

#[derive(Debug, Default)]
struct AuthFailureThrottle {
    by_peer: BTreeMap<String, u128>,
    window_start: u128,
    window_count: usize,
}

impl AuthFailureThrottle {
    fn should_deliver(&mut self, key: &str, now: u128) -> bool {
        let key = if key.trim().is_empty() {
            "unknown"
        } else {
            key.trim()
        };
        if self
            .by_peer
            .get(key)
            .is_some_and(|last| now.saturating_sub(*last) < AUTH_FAILURE_WINDOW_MS)
        {
            return false;
        }
        self.by_peer.insert(key.to_owned(), now);

        if now.saturating_sub(self.window_start) >= AUTH_FAILURE_WINDOW_MS {
            self.window_start = now;
            self.window_count = 0;
        }
        if self.window_count >= AUTH_FAILURE_DELIVERY_MAX {
            return false;
        }
        self.window_count += 1;
        true
    }
}

pub fn start_hosted_server_background<Runtime>(
    config: HostedConfig,
    resolver: PathResolver,
    runtime: Arc<Mutex<Runtime>>,
) -> Result<Option<JoinHandle<()>>>
where
    Runtime: DaemonRouteRuntime + Send + 'static,
{
    if !config.enabled {
        return Ok(None);
    }
    let principal_count = HostedPrincipalsStore::with_resolver(resolver.clone())
        .count_active_principals()
        .context("count hosted principals")?;
    let startup = validate_hosted_startup(&config, principal_count);
    if startup.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(anyhow!(
            startup
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("hosted mode startup validation failed")
                .to_owned()
        ));
    }

    let listener = TcpListener::bind((config.bind_address.as_str(), config.port))
        .with_context(|| format!("bind hosted listener on {}", config.bind_address))?;
    let state = Arc::new(HostedServerState::with_resolver(config, resolver));
    let prune_state = Arc::clone(&state);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(PRUNE_INTERVAL_MS));
        loop {
            prune_state.prune();
            thread::sleep(Duration::from_millis(PRUNE_INTERVAL_MS));
        }
    });

    Ok(Some(thread::spawn(move || {
        let serve_state = Arc::clone(&state);
        let stream_runtime = Arc::clone(&runtime);
        let stream_state = Arc::clone(&state);
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else {
                continue;
            };
            let peer_address = stream
                .peer_addr()
                .ok()
                .map(|address| address.ip().to_string());
            let handle_runtime = Arc::clone(&runtime);
            let handle_state = Arc::clone(&serve_state);
            let intercept_runtime = Arc::clone(&stream_runtime);
            let intercept_state = Arc::clone(&stream_state);
            thread::spawn(move || {
                let _ = handle_hosted_daemon_stream(
                    &handle_runtime,
                    &handle_state,
                    &intercept_runtime,
                    &intercept_state,
                    &mut stream,
                    DaemonRequestMetadata {
                        issued_at: now_iso(),
                        stopping: false,
                    },
                    peer_address.as_deref(),
                );
            });
        }
    })))
}

fn spawn_hosted_outbox_drain_background(
    outbox: HostedOutboxStore,
    delivery: Arc<Mutex<HostedEventDelivery>>,
    signal: Arc<HostedOutboxDrainSignal>,
    backstop: Duration,
) -> JoinHandle<()> {
    thread::spawn(move || {
        while signal.wait_for_next_run(backstop) {
            drain_hosted_outbox(&outbox, &delivery);
        }
    })
}

pub fn handle_hosted_daemon_stream<Runtime, Stream>(
    handle_runtime: &Arc<Mutex<Runtime>>,
    handle_state: &Arc<HostedServerState>,
    intercept_runtime: &Arc<Mutex<Runtime>>,
    intercept_state: &Arc<HostedServerState>,
    stream: &mut Stream,
    metadata: DaemonRequestMetadata,
    peer_address: Option<&str>,
) -> Result<(), crate::daemon::listener::DaemonListenerError>
where
    Runtime: DaemonRouteRuntime,
    Stream: std::io::Read + Write,
{
    handle_daemon_stream_with_metadata_and_interceptor_and_body_limit(
        stream,
        metadata,
        &mut |head| hosted_body_limit_for_head(&handle_state.config, head),
        &mut |request, writer| {
            maybe_handle_hosted_operator_stream_request(
                intercept_runtime,
                intercept_state,
                request,
                writer,
                peer_address,
            )
            .map_err(|error| {
                crate::daemon::listener::DaemonListenerError::Io(std::io::Error::other(
                    error.to_string(),
                ))
            })
        },
        &mut |request| {
            let mut runtime = handle_runtime
                .lock()
                .expect("hosted daemon runtime mutex poisoned");
            handle_hosted_daemon_request_from_peer(
                &mut *runtime,
                handle_state,
                request,
                peer_address,
            )
        },
    )
}

pub fn maybe_handle_hosted_operator_stream_request<Runtime>(
    runtime: &Arc<Mutex<Runtime>>,
    state: &HostedServerState,
    request: &DaemonHttpRequest,
    writer: &mut impl Write,
    peer_address: Option<&str>,
) -> Result<bool, HostAgentStreamError>
where
    Runtime: DaemonRouteRuntime,
{
    let route_url = DaemonRouteUrl::parse(&request.path);
    if request.method != "GET" || !is_hosted_stream_path(route_url.pathname()) {
        return Ok(false);
    }
    if request.stopping {
        write_prepared(
            writer,
            &hosted_json(
                503,
                json!({ "ok": false, "error": "aimux daemon is stopping" }),
            ),
        )?;
        return Ok(true);
    }
    if state
        .lockdown
        .is_locked_down(unix_millis(SystemTime::now()))
    {
        write_prepared(
            writer,
            &hosted_json(
                503,
                json!({ "ok": false, "error": "hosted mode is locked down" }),
            ),
        )?;
        return Ok(true);
    }

    let peer_key = hosted_client_address(peer_address, &request.headers, &state.config)
        .unwrap_or_else(|| "unknown".to_owned());
    let peer_slot = match state.peer_limiter.acquire(&peer_key) {
        HostedLimitOutcome::Allowed(release) => release,
        HostedLimitOutcome::Denied(_) => {
            write_prepared(
                writer,
                &hosted_json(429, json!({ "ok": false, "error": "too many requests" })),
            )?;
            return Ok(true);
        }
    };

    let headers = strip_trusted_headers(&request.headers);
    let auth = match authenticate_hosted(&headers, &state.principals) {
        Ok(auth) => auth,
        Err(_) => {
            peer_slot.release();
            write_prepared(
                writer,
                &hosted_json(401, json!({ "ok": false, "error": "unauthorized" })),
            )?;
            return Ok(true);
        }
    };
    if !auth.ok {
        record_auth_failure(state, "GET", &headers, peer_address, auth.reason.as_deref());
        peer_slot.release();
        write_prepared(
            writer,
            &hosted_json(401, json!({ "ok": false, "error": "unauthorized" })),
        )?;
        return Ok(true);
    }
    let principal = auth.principal.expect("authenticated principal");
    let actor = auth.actor.expect("authenticated hosted actor");
    let open_slot = match state.limiter.acquire(&principal.id) {
        HostedLimitOutcome::Allowed(release) => release,
        HostedLimitOutcome::Denied(denied) => {
            let error = if denied.reason == "rate" {
                "rate limit exceeded"
            } else {
                "too many requests"
            };
            peer_slot.release();
            write_prepared(
                writer,
                &hosted_json(429, json!({ "ok": false, "error": error })),
            )?;
            return Ok(true);
        }
    };
    open_slot.release();

    let resolved = {
        let runtime = runtime
            .lock()
            .expect("hosted daemon runtime mutex poisoned");
        let projects = runtime.list_projects_for_route();
        resolve_hosted_operator_stream(&actor, "GET", &request.path, &projects)
    };
    let target = match resolved {
        Ok(target) => target,
        Err(decision) => {
            peer_slot.release();
            write_prepared(
                writer,
                &hosted_json(
                    decision.status.unwrap_or(403),
                    json!({
                        "ok": false,
                        "error": decision.error.as_deref().unwrap_or("remote access denied")
                    }),
                ),
            )?;
            return Ok(true);
        }
    };
    if !state.acquire_stream(&principal.id) {
        peer_slot.release();
        write_prepared(
            writer,
            &hosted_json(
                429,
                json!({ "ok": false, "error": "too many concurrent streams" }),
            ),
        )?;
        return Ok(true);
    }
    peer_slot.release();
    pipe_hosted_project_event_stream(
        state,
        writer,
        &principal,
        route_url,
        &target.project_root,
        &ProjectEventStreamTarget {
            url: target.url,
            headers: BTreeMap::new(),
        },
    );
    state.release_stream(&principal.id);
    Ok(true)
}

fn pipe_hosted_project_event_stream(
    state: &HostedServerState,
    writer: &mut impl Write,
    principal: &HostedPrincipal,
    route_url: DaemonRouteUrl,
    project_root: &str,
    target: &ProjectEventStreamTarget,
) {
    let stream_ref = random_uuid_like();
    let started = Instant::now();
    let mut response_bytes = 0_usize;
    let mut status = 200_u16;
    audit_stream(
        state,
        principal,
        HostedStreamAudit {
            route_url: &route_url,
            status: 200,
            event: "open",
            response_bytes: 0,
            duration_ms: 0,
            stream_ref: Some(&stream_ref),
        },
    );

    let read_timeout_ms = state.stream_limits.reauth_interval_ms.max(1).min(
        HostAgentStreamRequestOptions::default()
            .timeout_ms
            .unwrap_or(10_000),
    );
    let mut opened = match open_project_event_stream_from_url(
        target,
        HostAgentStreamRequestOptions {
            timeout_ms: Some(read_timeout_ms),
        },
    ) {
        Ok(opened) => opened,
        Err(error) => {
            status = 502;
            let close_reason = "upstream";
            let _ = write_prepared(
                writer,
                &hosted_json(502, json!({ "ok": false, "error": error.to_string() })),
            );
            audit_stream(
                state,
                principal,
                HostedStreamAudit {
                    route_url: &route_url,
                    status,
                    event: &format!("closed:{close_reason}"),
                    response_bytes,
                    duration_ms: started.elapsed().as_millis(),
                    stream_ref: Some(&stream_ref),
                },
            );
            return;
        }
    };
    if !(200..300).contains(&opened.status()) {
        status = 502;
        let close_reason = "upstream";
        let message = opened.body_text().trim().to_owned();
        let _ = write_prepared(
            writer,
            &hosted_json(
                502,
                json!({ "ok": false, "error": if message.is_empty() { "upstream stream unavailable" } else { &message } }),
            ),
        );
        audit_stream(
            state,
            principal,
            HostedStreamAudit {
                route_url: &route_url,
                status,
                event: &format!("closed:{close_reason}"),
                response_bytes,
                duration_ms: started.elapsed().as_millis(),
                stream_ref: Some(&stream_ref),
            },
        );
        return;
    }

    if write_hosted_stream_headers(writer).is_err() {
        let close_reason = "client";
        audit_stream(
            state,
            principal,
            HostedStreamAudit {
                route_url: &route_url,
                status,
                event: &format!("closed:{close_reason}"),
                response_bytes,
                duration_ms: started.elapsed().as_millis(),
                stream_ref: Some(&stream_ref),
            },
        );
        return;
    }

    let granted_session_id = route_url
        .search_param("sessionId")
        .map(str::trim)
        .unwrap_or_default()
        .to_owned();
    let mut last_chunk_at = Instant::now();
    let mut last_reauth_at = Instant::now();
    let close_reason;
    loop {
        let now = Instant::now();
        if now.duration_since(started).as_millis() >= state.stream_limits.max_lifetime_ms as u128 {
            close_reason = "lifetime";
            break;
        }
        if now.duration_since(last_chunk_at).as_millis()
            >= state.stream_limits.idle_timeout_ms as u128
        {
            close_reason = "idle";
            break;
        }
        if now.duration_since(last_reauth_at).as_millis()
            >= state.stream_limits.reauth_interval_ms as u128
        {
            last_reauth_at = now;
            if !stream_principal_still_allowed(
                state,
                &principal.id,
                project_root,
                &granted_session_id,
            ) {
                close_reason = "revoked";
                break;
            }
        }

        match opened.next_chunk() {
            Ok(ProjectEventStreamChunk::Data(chunk)) => {
                let next_bytes = response_bytes.saturating_add(chunk.len());
                if next_bytes > state.stream_limits.max_bytes {
                    close_reason = "budget";
                    break;
                }
                if writer.write_all(&chunk).is_err() {
                    close_reason = "client";
                    break;
                }
                response_bytes = next_bytes;
                last_chunk_at = Instant::now();
            }
            Ok(ProjectEventStreamChunk::Timeout) => {}
            Ok(ProjectEventStreamChunk::Eof) => {
                close_reason = "eof";
                break;
            }
            Err(_) => {
                status = 502;
                close_reason = "error";
                break;
            }
        }
    }
    audit_stream(
        state,
        principal,
        HostedStreamAudit {
            route_url: &route_url,
            status,
            event: &format!("closed:{close_reason}"),
            response_bytes,
            duration_ms: started.elapsed().as_millis(),
            stream_ref: Some(&stream_ref),
        },
    );
}

fn stream_principal_still_allowed(
    state: &HostedServerState,
    principal_id: &str,
    project_root: &str,
    session_id: &str,
) -> bool {
    let Ok(Some(principal)) = state.principals.find_principal_by_id(principal_id) else {
        return false;
    };
    principal_has_grant(
        &principal,
        &HostedGrant {
            project_root: project_root.to_owned(),
            session_id: session_id.to_owned(),
        },
    )
}

struct HostedStreamAudit<'a> {
    route_url: &'a DaemonRouteUrl,
    status: u16,
    event: &'a str,
    response_bytes: usize,
    duration_ms: u128,
    stream_ref: Option<&'a str>,
}

fn audit_stream(
    state: &HostedServerState,
    principal: &HostedPrincipal,
    audit: HostedStreamAudit<'_>,
) {
    state.audit.append_audit(&HostedAuditRecord {
        ts: now_iso(),
        principal_id: principal.id.clone(),
        label: bounded_field(Some(principal.label.as_str())).unwrap_or_else(|| "-".to_owned()),
        method: "GET".to_owned(),
        path: bounded_field(Some(audit.route_url.pathname())).unwrap_or_default(),
        session_id: bounded_field(audit.route_url.search_param("sessionId")),
        status: audit.status.into(),
        request_bytes: 0,
        response_bytes: audit.response_bytes as i64,
        prompt_hash: None,
        prompt_ref: None,
        event: Some(format!("hosted_stream_{}", audit.event)),
        detail: audit
            .stream_ref
            .map(|stream_ref| format!("{stream_ref} {}ms", audit.duration_ms)),
    });
}

pub fn handle_hosted_daemon_request(
    runtime: &mut impl DaemonRouteRuntime,
    state: &HostedServerState,
    request: DaemonHttpRequest,
) -> PreparedDaemonResponse {
    handle_hosted_daemon_request_from_peer(runtime, state, request, None)
}

pub fn handle_hosted_daemon_request_from_peer(
    runtime: &mut impl DaemonRouteRuntime,
    state: &HostedServerState,
    request: DaemonHttpRequest,
    peer_address: Option<&str>,
) -> PreparedDaemonResponse {
    if request.stopping {
        return hosted_json(
            503,
            json!({ "ok": false, "error": "aimux daemon is stopping" }),
        );
    }

    let route_url = DaemonRouteUrl::parse(&request.path);
    let method = request.method.to_uppercase();
    let locked_down = state
        .lockdown
        .is_locked_down(unix_millis(SystemTime::now()));

    if method == "GET" && route_url.pathname() == "/health" {
        return hosted_json(
            200,
            json!({ "ok": true, "mode": "hosted", "lockdown": locked_down }),
        );
    }
    if locked_down {
        return hosted_json(
            503,
            json!({ "ok": false, "error": "hosted mode is locked down" }),
        );
    }

    let peer_key = hosted_client_address(peer_address, &request.headers, &state.config)
        .unwrap_or_else(|| "unknown".to_owned());
    let peer_slot = match state.peer_limiter.acquire(&peer_key) {
        HostedLimitOutcome::Allowed(release) => release,
        HostedLimitOutcome::Denied(_) => {
            return hosted_json(429, json!({ "ok": false, "error": "too many requests" }));
        }
    };

    let response = handle_authenticated(runtime, state, request, &method, &route_url, peer_address);
    peer_slot.release();
    response
}

fn handle_authenticated(
    runtime: &mut impl DaemonRouteRuntime,
    state: &HostedServerState,
    request: DaemonHttpRequest,
    method: &str,
    route_url: &DaemonRouteUrl,
    peer_address: Option<&str>,
) -> PreparedDaemonResponse {
    let headers = strip_trusted_headers(&request.headers);
    let auth = match authenticate_hosted(&headers, &state.principals) {
        Ok(auth) => auth,
        Err(_) => return hosted_json(401, json!({ "ok": false, "error": "unauthorized" })),
    };
    if !auth.ok {
        record_auth_failure(
            state,
            method,
            &headers,
            peer_address,
            auth.reason.as_deref(),
        );
        return hosted_json(401, json!({ "ok": false, "error": "unauthorized" }));
    }

    if parse_proxy_target(route_url.pathname()).is_none() {
        return hosted_json(404, json!({ "ok": false, "error": "not found" }));
    }

    let principal = auth.principal.expect("authenticated principal");
    let actor = auth.actor.expect("authenticated hosted actor");
    let slot = match state.limiter.acquire(&principal.id) {
        HostedLimitOutcome::Allowed(release) => release,
        HostedLimitOutcome::Denied(denied) => {
            let error = if denied.reason == "rate" {
                "rate limit exceeded"
            } else {
                "too many requests"
            };
            return hosted_json(429, json!({ "ok": false, "error": error }));
        }
    };

    let mut status = 500;
    let mut request_bytes = 0_usize;
    let mut response_bytes = 0_usize;
    let mut body = None;
    let response = (|| {
        if method != "GET" && method != "HEAD" {
            request_bytes = request.body_chunks.iter().map(Vec::len).sum();
            if request_bytes > body_cap(&state.config, route_url.pathname()) {
                status = 413;
                return hosted_json(
                    413,
                    json!({ "ok": false, "error": "request body too large" }),
                );
            }
            match read_hosted_json_body(&request.body_chunks) {
                Ok(value) => body = Some(value),
                Err(_) => {
                    status = 400;
                    return hosted_json(400, json!({ "ok": false, "error": "invalid json body" }));
                }
            }
            if !state.limiter.charge(&principal.id, request_bytes as f64) {
                status = 429;
                return hosted_json(
                    429,
                    json!({ "ok": false, "error": "upload volume limit exceeded" }),
                );
            }
        }

        let projects = runtime.list_projects_for_route();
        let context = build_hosted_daemon_route_context(
            method,
            &request.path,
            body.as_ref(),
            &actor,
            &projects,
        );
        let routed = route_daemon_request(
            runtime,
            method,
            &request.path,
            body.as_ref(),
            &request.issued_at,
            &context,
        );
        let prepared = prepare_hosted_route_response(routed, &state.config);
        status = prepared.status;
        response_bytes = prepared.body.len();
        prepared
    })();

    slot.release();
    record_authenticated_bookkeeping(
        state,
        &principal,
        HostedRequestBookkeeping {
            method,
            route_url,
            headers: &headers,
            body: body.as_ref(),
            status,
            request_bytes,
            response_bytes,
            peer_address,
        },
    );
    response
}

fn record_auth_failure(
    state: &HostedServerState,
    method: &str,
    headers: &BTreeMap<String, String>,
    peer_address: Option<&str>,
    reason: Option<&str>,
) {
    let ts = now_iso();
    let detail = reason.unwrap_or("unauthorized");
    let address = hosted_client_address(peer_address, headers, &state.config);
    state.audit.append_audit(&HostedAuditRecord {
        ts: ts.clone(),
        principal_id: "-".to_owned(),
        label: "-".to_owned(),
        method: method.to_owned(),
        path: "-".to_owned(),
        session_id: None,
        status: 401,
        request_bytes: 0,
        response_bytes: 0,
        prompt_hash: None,
        prompt_ref: None,
        event: Some("hosted_auth_failed".to_owned()),
        detail: Some(detail.to_owned()),
    });
    let Some(user_agent) = headers.get("user-agent").cloned() else {
        return;
    };
    let key = address.as_deref().unwrap_or("unknown");
    if !state.should_deliver_auth_failure(key) {
        return;
    }
    state.enqueue_delivery_async(HostedEvent {
        id: random_uuid_like(),
        kind: "hosted_auth_failed".to_owned(),
        ts,
        principal_id: None,
        label: None,
        session_id: None,
        fingerprint: None,
        address_known: address.is_some(),
        user_agent: Some(user_agent),
        detail: Some(detail.to_owned()),
    });
}

struct HostedRequestBookkeeping<'a> {
    method: &'a str,
    route_url: &'a DaemonRouteUrl,
    headers: &'a BTreeMap<String, String>,
    body: Option<&'a Value>,
    status: u16,
    request_bytes: usize,
    response_bytes: usize,
    peer_address: Option<&'a str>,
}

fn record_authenticated_bookkeeping(
    state: &HostedServerState,
    principal: &HostedPrincipal,
    request: HostedRequestBookkeeping<'_>,
) {
    let ts = now_iso();
    let prompt_text = prompt_text_of(request.body);
    let mut record = HostedAuditRecord {
        ts: ts.clone(),
        principal_id: principal.id.clone(),
        label: bounded_field(Some(principal.label.as_str())).unwrap_or_else(|| "-".to_owned()),
        method: request.method.to_owned(),
        path: bounded_field(Some(request.route_url.pathname())).unwrap_or_default(),
        session_id: bounded_field(
            audited_session_id(request.method, request.route_url, request.body).as_deref(),
        ),
        status: request.status.into(),
        request_bytes: request.request_bytes as i64,
        response_bytes: request.response_bytes as i64,
        prompt_hash: None,
        prompt_ref: None,
        event: None,
        detail: None,
    };
    if let Some(prompt_text) = prompt_text {
        record.prompt_hash = Some(hash_prompt(prompt_text));
        if state.config.audit_prompt_bodies && (200..300).contains(&request.status) {
            let kept = prompt_text
                .chars()
                .take(MAX_AUDIT_PROMPT_CHARS)
                .collect::<String>();
            let prompt_ref = random_uuid_like();
            record.prompt_ref = Some(prompt_ref.clone());
            state.audit.append_prompt(&HostedPromptRecord {
                ts: ts.clone(),
                prompt_ref,
                principal_id: principal.id.clone(),
                prompt_hash: record.prompt_hash.clone().unwrap_or_default(),
                prompt_text: kept.clone(),
                truncated: (kept.len() < prompt_text.len()).then_some(true),
            });
        }
    }
    state.audit.append_audit(&record);
    let _ = state.principals.mark_principal_seen(&principal.id);
    let sighting = state.devices.record_device_sighting(SeenDeviceInput {
        principal_id: principal.id.clone(),
        label: bounded_field(Some(principal.label.as_str())).unwrap_or_else(|| "-".to_owned()),
        address: hosted_client_address(request.peer_address, request.headers, &state.config),
        user_agent: request.headers.get("user-agent").cloned(),
    });
    if let Some(sighting) = sighting {
        state.audit.append_audit(&HostedAuditRecord {
            ts: sighting.ts.clone(),
            principal_id: principal.id.clone(),
            label: bounded_field(Some(principal.label.as_str())).unwrap_or_else(|| "-".to_owned()),
            method: "-".to_owned(),
            path: "-".to_owned(),
            session_id: None,
            status: 0,
            request_bytes: 0,
            response_bytes: 0,
            prompt_hash: None,
            prompt_ref: None,
            event: Some(sighting.kind.clone()),
            detail: sighting.fingerprint.clone(),
        });
        state.spool_delivery_event(&sighting);
    }
}

fn prepare_hosted_route_response(
    response: crate::daemon::routing::DaemonRouteResponse,
    config: &HostedConfig,
) -> PreparedDaemonResponse {
    match response.body {
        DaemonResponseBody::Bytes(bytes) => {
            if bytes.len() > config.max_attachment_bytes as usize {
                return hosted_json(
                    502,
                    json!({ "ok": false, "error": "upstream response too large" }),
                );
            }
            let declared = response
                .content_type
                .as_deref()
                .unwrap_or_default()
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            if !SERVABLE_BINARY_TYPES.contains(&declared.as_str()) {
                return hosted_json(
                    502,
                    json!({ "ok": false, "error": "upstream returned an unsupported content type" }),
                );
            }
            let mut prepared = prepare_daemon_response(
                response.status,
                DaemonResponseBody::Bytes(bytes),
                Some(&declared),
            );
            prepared
                .headers
                .insert("cache-control".to_owned(), "no-store".to_owned());
            prepared
                .headers
                .insert("x-content-type-options".to_owned(), "nosniff".to_owned());
            prepared
                .headers
                .insert("content-disposition".to_owned(), "inline".to_owned());
            prepared
        }
        body => {
            let content_type = response
                .content_type
                .as_deref()
                .unwrap_or("application/json");
            let bytes = body.bytes(content_type);
            if bytes.len() > config.max_response_bytes as usize {
                return hosted_json(
                    502,
                    json!({ "ok": false, "error": "upstream response too large" }),
                );
            }
            let mut prepared = prepare_daemon_response(
                response.status,
                DaemonResponseBody::Bytes(bytes),
                Some(content_type),
            );
            prepared
                .headers
                .insert("cache-control".to_owned(), "no-store".to_owned());
            prepared
        }
    }
}

fn hosted_json(status: u16, body: Value) -> PreparedDaemonResponse {
    let mut response = prepare_daemon_response(status, DaemonResponseBody::Json(body), None);
    response
        .headers
        .insert("cache-control".to_owned(), "no-store".to_owned());
    response
}

fn hosted_body_limit_for_head(
    config: &HostedConfig,
    head: &DaemonRequestHead,
) -> Option<DaemonRequestBodyLimit> {
    let method = head.method.to_ascii_uppercase();
    if method == "GET" || method == "HEAD" {
        let has_body = head
            .headers
            .get("content-length")
            .and_then(|value| value.parse::<usize>().ok())
            .is_some_and(|length| length > 0)
            || head
                .headers
                .get("transfer-encoding")
                .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"));
        if !has_body {
            return None;
        }
    }
    Some(DaemonRequestBodyLimit {
        max_bytes: body_cap(config, DaemonRouteUrl::parse(&head.path).pathname()),
        too_large_response: hosted_json(
            413,
            json!({ "ok": false, "error": "request body too large" }),
        ),
    })
}

fn hosted_client_address(
    peer_address: Option<&str>,
    headers: &BTreeMap<String, String>,
    config: &HostedConfig,
) -> Option<String> {
    client_address(
        peer_address,
        headers,
        config.trusted_forwarded_header.as_deref(),
    )
}

fn write_hosted_stream_headers(writer: &mut impl Write) -> Result<(), HostAgentStreamError> {
    writer
        .write_all(
            b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\nx-accel-buffering: no\r\nconnection: close\r\n\r\n",
        )
        .map_err(|error| HostAgentStreamError::Io(error.to_string()))
}

fn read_hosted_json_body(chunks: &[Vec<u8>]) -> Result<Value> {
    let mut body = Vec::new();
    for chunk in chunks {
        body.extend_from_slice(chunk);
    }
    let text = String::from_utf8(body)?.trim().to_owned();
    if text.is_empty() {
        return Ok(json!({}));
    }
    Ok(serde_json::from_str(&text)?)
}

fn body_cap(config: &HostedConfig, pathname: &str) -> usize {
    if let Some(target) = parse_proxy_target(pathname) {
        if target.sub_path.contains("/attachments/") || target.sub_path == "/attachments" {
            return config.max_attachment_bytes as usize;
        }
        if is_binary_project_route(&target.sub_path) {
            return config.max_attachment_bytes as usize;
        }
        if target.sub_path.ends_with("/agents/prompt-context") {
            return config.max_context_bytes as usize;
        }
    }
    config.max_prompt_bytes as usize
}

fn is_hosted_stream_path(pathname: &str) -> bool {
    parse_proxy_target(pathname)
        .as_ref()
        .is_some_and(|target| target.sub_path == project_routes::agents::OUTPUT_STREAM)
}

fn write_prepared(
    writer: &mut impl Write,
    response: &PreparedDaemonResponse,
) -> Result<(), HostAgentStreamError> {
    writer
        .write_all(&prepared_response_bytes(response))
        .map_err(|error| HostAgentStreamError::Io(error.to_string()))
}

fn audited_session_id(
    method: &str,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> Option<String> {
    if method == "GET" {
        return route_url
            .search_param("sessionId")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
    }
    body.and_then(|body| body.get("sessionId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn prompt_text_of(body: Option<&Value>) -> Option<&str> {
    body.and_then(|body| body.get("text"))
        .and_then(Value::as_str)
}

fn bounded_field(value: Option<&str>) -> Option<String> {
    let value = value?;
    if value.len() <= MAX_AUDIT_FIELD_CHARS {
        Some(value.to_owned())
    } else {
        Some(value.chars().take(MAX_AUDIT_FIELD_CHARS).collect())
    }
}

fn now_iso() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let total_seconds = duration.as_secs();
    let days = (total_seconds / 86_400) as i64;
    let seconds_in_day = total_seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_in_day / 3_600;
    let minute = (seconds_in_day % 3_600) / 60;
    let second = seconds_in_day % 60;
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        duration.subsec_millis()
    )
}

fn random_uuid_like() -> String {
    format!(
        "00000000-0000-4000-8000-{number:012}",
        number = unix_millis(SystemTime::now()) % 1_000_000_000_000
    )
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let days = days_since_epoch + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

fn unix_millis(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hosted_events::HostedEventDeliveryConfig;
    use std::io::Read;
    use std::net::TcpStream;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;

    #[test]
    fn hosted_outbox_signal_drains_without_waiting_for_backstop() {
        let fixture = HostedServerFixture::new("outbox-signal");
        let webhook = CountingWebhookServer::spawn();
        let state = Arc::new(HostedServerState::with_resolver_and_delivery(
            HostedConfig {
                enabled: true,
                webhook_url: Some(format!("http://127.0.0.1:{}/hook", webhook.port)),
                ..HostedConfig::default()
            },
            fixture.resolver.clone(),
            HostedEventDelivery::new(HostedEventDeliveryConfig {
                webhook_url: Some(format!("http://127.0.0.1:{}/hook", webhook.port)),
                webhook_secret: Some("secret".into()),
            }),
        ));

        state.spool_delivery_event(&hosted_event("hosted_new_device"));

        webhook.wait_for_count(1, Duration::from_millis(500));
    }

    #[test]
    fn hosted_outbox_failed_delivery_handoff_preserves_drained_events() {
        let fixture = HostedServerFixture::new("outbox-failed-handoff");
        let state = HostedServerState::with_resolver_and_delivery(
            HostedConfig {
                enabled: true,
                ..HostedConfig::default()
            },
            fixture.resolver.clone(),
            HostedEventDelivery::new(HostedEventDeliveryConfig {
                webhook_url: Some("http://127.0.0.1:9/hook".into()),
                webhook_secret: Some("secret".into()),
            }),
        );
        let event = hosted_event("hosted_token_revoked");
        state.outbox.spool_event(&event);
        let delivery = Arc::clone(&state.delivery);
        let _ = std::panic::catch_unwind(move || {
            let _guard = delivery.lock().expect("delivery lock");
            panic!("poison delivery lock");
        });

        assert!(matches!(
            drain_hosted_outbox(&state.outbox, &state.delivery),
            HostedOutboxDrainResult::Failed
        ));

        let preserved = state
            .outbox
            .try_drain_outbox()
            .expect("preserved outbox drains");
        assert_eq!(preserved, vec![event]);
    }

    struct HostedServerFixture {
        root: PathBuf,
        resolver: PathResolver,
    }

    impl HostedServerFixture {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "aimux-hosted-server-unit-{name}-{}-{}",
                std::process::id(),
                unix_millis(SystemTime::now())
            ));
            std::fs::create_dir_all(&root).expect("fixture root");
            let resolver = PathResolver::new(
                "/",
                &root,
                Some(root.join(".aimux").to_string_lossy().into_owned()),
            );
            Self { root, resolver }
        }
    }

    impl Drop for HostedServerFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    struct CountingWebhookServer {
        port: u16,
        count: Arc<AtomicUsize>,
        stop: mpsc::Sender<()>,
        worker: Mutex<Option<thread::JoinHandle<()>>>,
    }

    impl CountingWebhookServer {
        fn spawn() -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind webhook");
            listener.set_nonblocking(true).expect("nonblocking webhook");
            let port = listener.local_addr().expect("webhook addr").port();
            let count = Arc::new(AtomicUsize::new(0));
            let worker_count = Arc::clone(&count);
            let (stop_tx, stop_rx) = mpsc::channel();
            let worker = thread::spawn(move || {
                loop {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let _ = read_webhook_request(&mut stream);
                            worker_count.fetch_add(1, Ordering::SeqCst);
                            let _ =
                                stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n");
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            if stop_rx.try_recv().is_ok() {
                                return;
                            }
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(error) => panic!("accept webhook: {error}"),
                    }
                }
            });
            Self {
                port,
                count,
                stop: stop_tx,
                worker: Mutex::new(Some(worker)),
            }
        }

        fn wait_for_count(&self, expected: usize, timeout: Duration) {
            let started = Instant::now();
            while started.elapsed() < timeout {
                if self.count.load(Ordering::SeqCst) >= expected {
                    return;
                }
                thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(self.count.load(Ordering::SeqCst), expected);
        }

        fn stop(&self) {
            let _ = self.stop.send(());
            if let Some(worker) = self.worker.lock().expect("worker lock").take() {
                worker.join().expect("webhook worker");
            }
        }
    }

    impl Drop for CountingWebhookServer {
        fn drop(&mut self) {
            self.stop();
        }
    }

    fn read_webhook_request(stream: &mut TcpStream) -> Vec<u8> {
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("webhook read timeout");
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 1024];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    bytes.extend_from_slice(&buffer[..count]);
                    if webhook_request_complete(&bytes) {
                        break;
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) =>
                {
                    break;
                }
                Err(error) => panic!("read webhook request: {error}"),
            }
        }
        bytes
    }

    fn webhook_request_complete(bytes: &[u8]) -> bool {
        let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
            return false;
        };
        let Ok(headers) = std::str::from_utf8(&bytes[..header_end]) else {
            return false;
        };
        let content_length = headers
            .split("\r\n")
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        bytes.len() >= header_end + 4 + content_length
    }

    fn hosted_event(kind: &str) -> HostedEvent {
        HostedEvent {
            id: format!("event-{kind}"),
            kind: kind.to_owned(),
            ts: "2026-09-12T00:00:00.000Z".to_owned(),
            principal_id: Some("principal".into()),
            label: Some("label".into()),
            session_id: None,
            fingerprint: None,
            address_known: false,
            user_agent: None,
            detail: None,
        }
    }
}
