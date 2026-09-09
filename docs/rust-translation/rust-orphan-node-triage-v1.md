# Rust Orphan Node Triage v1

Generated from `scripts/audit-rust-orphans.mjs` output on `master` after the
Rust cutover. The question for each high-signal public orphan is narrow: did
Node call the equivalent function from a real user path before phase 8? If yes,
this records whether Rust reaches the same behavior through another path or is
missing a live wire.

Raw full-suite gate before this triage:

- `cargo +1.92.0 test -p aimux --all-targets`: 758 passed, 1 failed, 0 ignored.
- Failure: `fixture_dashboard_targets_contract_is_captured` in
  `native/crates/aimux/tests/fixture_dashboard_targets.rs`.
- `cargo +1.92.0 clippy -p aimux --all-targets -- -D warnings`: passed.
- `cargo +1.92.0 fmt --check`: passed.

The cargo failure is in the dashboard-targets/TUI lane and was not changed here.

## Live Bugs

| Rust symbol | Node called from real user path? | Current Rust gap |
| --- | --- | --- |
| `daemon_projects::count_online_desktop_agents` | Yes. Node `src/daemon/projects-route.ts` called `countOnlineDesktopAgents()` from the real daemon `GET /projects` route by sampling each live project service's `/desktop-state`, with a short cache and timeout. | Fixed in `1adb0007`: Rust `GET /projects` now reads `onlineAgentCount` from each live project service and caches the count for the Node TTL. Missing behavior before the fix: GUI project lists could show no online-agent counts even though the counting helper and fixtures existed. |
| `event_loop_budget::assess_loop_budget` and `tmux_exec_metrics::get_tmux_exec_metrics` | Yes. Node `src/daemon.ts` called `getEventLoopDelay()`, `getTmuxExecMetrics()`, and `assessLoopBudget()` from the real loopback `GET /diagnostics/loop` route. | Fixed in `aaebea65`: Rust loop diagnostics now reports uptime, event-loop status, tmux exec metrics, budget verdict, excludes, and notes through the real daemon JSON route. Missing behavior before the fix: diagnostics existed but returned empty metric placeholders, so load/loop budget telemetry was not observable after cutover. |
| `project_service::operation_failures::list_dashboard_operation_failures` | Yes. Node `src/multiplexer/dashboard-model.ts` read `listDashboardOperationFailures()` while building desktop state, and `src/multiplexer/persistence-methods.ts` used it to project failed worktree rows. | Fixed in `775829df`: Rust project-service `GET /desktop-state` now includes active persisted operation failures instead of hard-coding `operationFailures: []`. Missing behavior before the fix: the existing failure store could contain records that the GUI API never surfaced. |
| `project_service::operation_failures::add_dashboard_operation_failure` | Yes. Node `src/multiplexer/persistence-methods.ts` recorded worktree create failures and `src/multiplexer/dashboard-tail-methods.ts` recorded agent create failures through `addDashboardOperationFailure`, which fed the dashboard FAILED OPERATIONS card. | Fixed in `50a2b042` and `992d5889`: Rust worktree create conflicts/create failures/remove failures and agent spawn failures now write the same persisted failure store, and successful create/remove or spawn clears matching failures. Mutation proof: no-oping the worktree or agent failure recorder fails `worktree_create_failure_persists_error_topology_entry` or `agent_spawn_failure_records_dashboard_operation_failure`. |
| `recording_cleanup::{plan_recording_cleanup, run_recording_cleanup}` and `install_config::{default_installs_config, is_primary_install_lane_with_home, load_installs_config_from_path}` | Yes. Node `src/daemon.ts` scheduled `runDiskMaintenance()` from daemon startup, then independently swept stale recordings and superseded installs using these helpers. | Fixed in `9e4802e2`: Rust daemon startup now schedules the same maintenance loop and runs stale recording cleanup plus primary-lane install cleanup through the existing planners. Missing behavior before the fix: stale recordings and superseded installs could only be cleaned by direct CLI/test paths, not by the long-lived daemon sweep Node had. |
| `project_service::interactions::register_interaction_watcher` | Yes. Node `metadata-server.ts` incremented `interactionWatchers` when `/agents/interaction/stream` opened, decremented it on close, and `/agents/interaction/request` only registered/waited when a watcher was active. | Fixed in `86a78571`: Rust registers the watcher for the lifetime of the actual SSE stream writer. Missing behavior before the fix: GUI interaction streams returned `ready`, but permission requests still saw `watching:false` and never waited for a GUI response. Mutation proof: disabling stream watcher registration fails `interaction_stream_registers_watcher_for_request_lifetime`. |
| `project_service_manifest::compute_current_project_service_manifest` | Yes. `src/project-service-manifest.ts` exported `computeCurrentProjectServiceManifest`, and `src/multiplexer/runtime-guard.ts` used the drift result during dashboard runtime guard probing. | Rust has the build-stamp computation but no production caller for the current-manifest/self-drift path. Missing behavior: a dashboard/project-service process can fail to classify itself stale after the installed build changes. This is TUI/runtime-guard wiring, so route to the TUI owner. |
| `project_service_manifest::has_project_service_build_drift` | Yes. `probeRuntimeGuard()` called `hasProjectServiceBuildDrift()` before endpoint and service checks. | Same missing self-drift wire as above. The pure guard fixture proves the decision matrix, but not the production probe that supplies `selfDrift`. Route to the TUI owner. |
| `TmuxRuntimeManager::has_window` | Yes. Node called `hasWindow` from `src/runtime-restart.ts` to restore active windows and guard killing failed repair dashboards, and from `src/multiplexer/services.ts` when removing an offline service with a saved tmux target. | Fixed after this row was first written. `e0e31309` wires it into daemon runtime restart/dashboard repair, and `f16b58cd` wires it into saved service target removal. Missing behavior before the fix: restart did not guard stale dashboard targets or restore active non-dashboard windows after reload, and offline service removal could skip the saved-target liveness check. |
| `TmuxRuntimeManager::link_window_to_session` | Yes. Node called `linkWindowToSession` from `relinkDashboardToClientSessions()` during runtime restart. | Fixed after this row was first written. `e0e31309` wires dashboard relinking into daemon runtime restart/repair. Missing behavior before the fix: after repair/restart, client sessions could remain attached to stale or missing dashboard windows. |
| `terminal_key_parser::is_shifted_letter_command` | Yes. Node called `isShiftedLetterCommand` from dashboard control, dashboard interaction, and help/navigation paths. | Rust has the parser helper but dashboard production key handling does not call it. Missing behavior risk: shifted-letter commands such as `L` for library can drift from Node's raw uppercase/shift handling. This is dashboard-controller/navigation wiring, so route to the TUI owner. |

## Node Yes, Rust Behavior Reached Elsewhere

| Rust symbol | Node called from real user path? | Why this orphan is not a live bug |
| --- | --- | --- |
| `backend_session_ids::discover_backend_session_id` | Yes. Node called `discoverBackendSessionId` from backend-id reconciliation. | Rust production calls `discover_backend_session_id_with_options` directly from the same reconciliation paths. The no-options wrapper is dead, but the behavior is wired. |
| `daemon_supervisor::stop_project_service` | Yes. Node called `stopProjectService` from runtime restart and the daemon restart route. | Rust daemon text/JSON/core routes call `DaemonCoreCommandRuntime::stop_project` directly. The exported supervisor wrapper is dead, but stop behavior is wired. |
| `process_inspector::is_native_aimux_project_service_process` | Yes for the Node equivalent `isAimuxProjectServiceProcess`, from daemon stop, project takeover, and runtime restart. | Rust production uses `is_current_native_aimux_project_service_process` or `is_aimux_project_service_process_args` at those points. This native-only wrapper is not the Node production shape. |
| `PathResolver::project_team_path_for` | Yes. Node `team.ts` used `getProjectTeamPath()` for project team config. | Rust project-service team config uses `project_service::team::project_team_path(project_root)`. The resolver method is an unused alternate path. |
| `paths::is_ephemeral_temp_project_root` | Yes, as a private Node helper inside project registry normalization. | Rust registry normalization calls `is_ephemeral_temp_project_root_from` directly. The public wrapper is dead, but the normalization behavior is wired. |
| `project_service::runtime_events::route_runtime_set_attention` | Yes for the `/runtime/attention` route behavior. | Rust production metadata routing calls `route_runtime_set_attention_with_context`; the context-free wrapper is dead. |
| `TmuxSessionTransport::set_backend_session_id` | Yes. Node set `transport.backendSessionId` when adopting live tmux windows. | Rust production stores backend identity in tmux metadata/topology and uses backend-id reconciliation directly; there is no long-lived `SessionRuntime` transport object on the native service path. The accessor belongs to the old object model. |
| `TmuxSessionTransport::retarget` | Yes. Node retargeted tmux-backed transports during persistence/runtime reconciliation. | Rust production reconciles live tmux targets through topology and tmux metadata rather than mutating a stored transport object. The retarget method is a compatibility/test seam. |
| `TmuxSessionTransport::destroy` | Yes. Node `SessionRuntime.destroy()` forwarded to the transport. | Rust lifecycle teardown is routed through project-service/daemon kill and topology state, not a long-lived transport object. The method is currently a no-op and not on a user path. |
| `TmuxRuntimeManager::ensure_project_session_async` | Yes. Node session launch preferred the async form when available. | Rust production calls the synchronous `ensure_project_session` through launch/runtime adapters. There is no missing async behavior after the Rust cutover. |

## Node Yes, Feature Not Production-Wired After Cutover

| Rust symbol | Node called from real user path? | Triage |
| --- | --- | --- |
| `PathResolver::hosted_audit_prompts_path` | Yes. Node hosted audit wrote and pruned `audit-prompts.jsonl`. | Rust has hosted audit contract coverage and hosted CLI persistence for principals/audit/lockdown/outbox, but no production hosted server path that writes prompt-body audit records. Treat this as a hosted-server follow-up, not a delete without product ruling. |
| `PathResolver::hosted_devices_path` | Yes. Node hosted events recorded/pruned device sightings in `devices.json`. | Rust has hosted events transport contracts but no production caller persisting device sightings through this resolver helper. Treat this as a hosted-events follow-up, not a silent delete. |
| `daemon::access::{build_hosted_daemon_route_context, resolve_hosted_operator_stream}` | Yes. Node `Daemon.startHostedListenerIfConfigured()` passed hosted request and stream resolvers into `startHostedServer`, and `src/full/hosted-server.ts` used the stream resolver for real operator event streams. | Rust has hosted security/runtime/event contracts and hosted CLI persistence, but no production hosted listener/server bridge comparable to Node's `startHostedServer`. Treat this as a hosted product-surface follow-up, not dead code. |

## Node No, Dead Or Contract-Only

| Rust symbol | Node called from real user path? | Triage |
| --- | --- | --- |
| `CoreCommandCall::transport_request` | No equivalent Node production helper found. | Rust convenience wrapper around `build_core_command_transport_request`; delete candidate after Sam rules on dead code. |
| `daemon_supervisor::project_service_status` | No production Node caller found; exported but only boundary/test references. | Delete candidate. |
| `daemon::listener::serve_daemon_http` | No Node equivalent. | Rust wrapper; production uses `serve_daemon_http_with_metadata_and_interceptor`. Delete candidate. |
| `DashboardProjectRefreshState::observe_all` | No Node equivalent production caller found. | Rust batch helper; production uses narrower observe paths. Delete candidate unless the TUI owner wants it. |
| `PathResolver::remove_project` | No production Node caller found. | Delete candidate; project deregistration is not currently a real user path. |
| `paths::require_git_project_root` | No Node equivalent; Node tolerated non-git projects. | Delete candidate or keep private only for git-specific commands. Public use would risk reintroducing the non-git refusal. |
| `ProjectServiceRoutePattern::exact_path` | No Node equivalent production caller found. | Accessor only; route matching uses `matches`/display paths. Delete candidate. |
| `ProjectServiceRouteSpec::exact_binary` | No Node equivalent production caller found. | Accessor only; no binary exact route uses it. Delete candidate. |
| `ProjectServiceRouteSpec::prefix_binary` | No Node equivalent production caller found. | Accessor only; no binary prefix route uses it. Delete candidate. |
| `project_service::routes::canonical_project_api_routes` | No production Node caller found. | Contract/list helper only. Keep only if route inventory tests still need it. |
| `ProjectHotSnapshotCoordinator::with_refresh_delay_ms` | No Node equivalent production caller found. | Test/configuration seam. Delete candidate. |
| `TmuxSessionTransport::manager_mut` | No Node equivalent production caller found. | Mutable test/accessor seam. Delete candidate. |
| `TmuxRuntimeManager::with_session_prefix` | No production Node caller found. | Test/private-prefix seam. Delete candidate unless private tmux prefixes are revived. |
| `TmuxRuntimeManager::peek_open_session_name` | No production Node caller found. | Node exposed it, but only tests referenced it. Delete candidate. |

## Second Orphan Pass

Generated from `scripts/audit-rust-orphans.mjs` after `e0e31309`, `f16b58cd`,
`86a78571`, `50a2b042`, and `992d5889`. Current sweep:

- Public functions checked: 1678.
- Graph-unreachable public functions: 475.
- Unreferenced production public functions: 294.
- Actionable after fixture/contract exclusions: 100.
- Needs Node-caller triage: 26.
- Test-only reachable: 64.
- TUI-owned: 10.

### Node Yes, Rust Behavior Reached Elsewhere

| Rust symbol | Node called from real user path? | Why this orphan is not a live bug |
| --- | --- | --- |
| `core_command_transport::request_core_command_with` | Yes for the Node behavior. `src/core-command-client.ts` sent the core command request from CLI/helper paths. | Rust production calls `core_command_client::request_core_command` from the native CLI executor. `request_core_command_with` is the injectable test seam. |
| `daemon_state::load_metadata_endpoint_by_project_id` | Yes. Node loaded project endpoints by id from daemon routes and project routing. | Rust production builds the id map through `service_endpoints_by_id_from_resolver` and resolves roots through `metadata_endpoint_for_root`. This wrapper is a test/helper path. |
| `daemon_supervisor::stop_project_service` | Yes. Node used `stopProjectService` from runtime restart and daemon stop paths. | Rust production routes stop/restart through `DaemonCoreCommandRuntime::stop_project` and daemon text/core routes. The exported supervisor wrapper is redundant. |
| `daemon::stream::{write_host_agent_stream_text, maybe_handle_host_agent_stream_request}` | Yes for the host-agent stream route. Node resolved `/core/host-agent-stream-text` and piped upstream SSE text to the caller. | Rust production calls `maybe_handle_host_agent_stream_request_with_runtime_mutex`, which delegates to `pipe_host_agent_stream_from_url`. The non-mutex handler and text writer are test seams. |
| `daemon::text::params::client_suffix_for_session` | Yes. Node used `clientSuffixForSession()` when opening a dashboard target back into the caller's client session. | Rust production performs this through tmux open/focus options and `TmuxRuntimeManager::resolve_client_suffix`. The daemon text helper is a tested parser seam. |
| `install_cleanup::is_install_cleanup_dry_run_value` | Yes. Node `main.ts` and `full/main.ts` used `isInstallCleanupDryRun()` for `doctor install-cleanup`. | Rust production parses the native doctor command into the cleanup plan directly; this JSON-value helper exists for the captured contract. |
| `install_config::{default_installs_config, load_installs_config_from_path}` | Yes. Node daemon startup loaded install maintenance config. | Rust production uses `PathResolver::from_env`, `normalize_installs_config`, and the daemon maintenance planner. The path-injected helpers are contract seams. |
| `project_service::agent_controls::{set_session_loop_metadata_at, clear_session_loop_metadata_at}` | Yes. Node loop commands mutated session loop metadata in the metadata store. | Rust production reaches the behavior through the project-service loop command routes and runtime exchange mutations. The `_at` variants are file-injected fixture seams. |
| `project_service::agent_output_projection::{project_or_reuse, project_agent_output_with_source}` | Yes for parser projection and cache behavior. Node projected parsed output from desktop-state and output APIs. | Rust production calls `project_agent_output` through the projection cache on the agent output routes. The exposed cache/source variants are fixture seams. |
| `project_service::coordination_worklist::{build_workflow_entries, filter_workflow_entries}` | Yes. Node `dashboard-model.ts` used `buildWorkflowEntries()` for desktop-state workflow counts and labels. | Rust desktop-state computes workflow counts/labels in `project_service::desktop_state`, and `/coordination-worklist` uses `build_coordination_view`. The exported workflow helpers are parity/fixture seams, not the production desktop-state path. |
| `project_service::runtime_events::{route_runtime_event, route_runtime_set_attention}` | Yes for runtime event and attention routes. | Rust production metadata routing calls the context-aware `route_runtime_event_with_context` and `route_runtime_set_attention_with_context`. The context-free wrappers are test seams. |
| `process_inspector::is_native_aimux_project_service_process` | Yes for the Node process classification behavior. | Rust production uses `is_current_native_aimux_project_service_process` and `is_aimux_project_service_process_args` on takeover, stop, and drift paths. This wrapper is not the production predicate. |
| `runtime_drift::is_aimux_build_drift_error` | Yes. Node CLI project-service commands rethrew drift errors by checking this helper. | Rust production classifies the same strings in command/error handling paths; the public function remains the captured parity seam. |
| `session_bootstrap::get_tool_resume_args` | Yes. Node exported `getToolResumeArgs()` and launch/migration paths used equivalent resume-arg expansion. | Rust production uses `project_service::lifecycle::agent_launch_helpers::resume_args` from launch, resume, fork, and migrate routes. The top-level helper is fixture-only. |
| `tmux_query_memo::with_tmux_query_memo` | Yes. Node wrapped desktop-state and session-runtime reconciliation in `withTmuxQueryMemo()`. | Rust production uses memoized tmux reads inside the concrete dashboard/project-service paths that need them. The public scope helper is retained for the contract suite. |
| `TmuxRuntimeManager::{has_session_async, create_window_async, clear_target_history_async, capture_target_async, set_window_metadata_async, set_window_option_async, set_session_option_async, apply_managed_agent_window_policy_async}` | Yes. Node used async tmux methods on async session-launch/expose paths. | Rust production uses synchronous tmux manager methods from the native project-service and daemon paths. The async wrappers are compatibility/test seams. |
| `TmuxRuntimeManager::respawn_window` | Yes. Node respawned windows from repair/service paths. | Rust production currently reaches respawn through lower-level argv helpers and the tmux doctor/repair code. The public manager method is fixture-only after the cutover. |
| `TmuxRuntimeManager::list_persisted_command_text` | Yes. Node install cleanup used persisted tmux command text while planning superseded install cleanup. | Rust daemon startup now runs install cleanup; the live sweep uses the cleanup planner and lower-level tmux command text parsing. The manager method is retained for the fixture suite. |
| `TmuxRuntimeManager::{switch_to_last_client_session, leave_managed_session}` | Yes. Node used these on dashboard leave/return flows. | Rust production dashboard leave behavior is in the TUI lane and currently uses the translated control path; the public manager helpers are fixture seams unless TUI owner decides to wire them directly. |

### Node No, Dead Or Contract-Only

| Rust symbol | Node called from real user path? | Triage |
| --- | --- | --- |
| `daemon::listener::{serve_daemon_http, handle_daemon_stream}` | No distinct Node helper equivalent; Node used the HTTP server directly. | Rust overload/test wrappers around the production metadata/interceptor listener. Delete candidates after Sam rules. |
| `dashboard_project_events::{observe_all, reset, should_render_after_project_event_refresh, run_input}` | No production Node caller for these exact helpers. | Event refresh behavior is wired through dashboard/project event routes; these are reducer/test seams. TUI owner should rule before deletion. |
| `exchange_alert_routing::resolve_exchange_alert_routing` | No production Node caller found after the cutover source audit. | Captured helper for alert-routing contracts; delete only if Sam retires the exchange-alert behavior. |
| `plugin_api::native_plugin_api_surface` | No Node equivalent. | Internal API inventory fixture for the native plugin surface, not production logic. |
| `process_inspector::read_process_args_from_ps_output` | No production Node helper equivalent. | Parser seam for process inspection fixtures. |
| `project_service_manifest::project_service_artifact_paths_with_native_candidates` | No production Node caller. | Test-injected variant for manifest artifact path discovery. Production calls `project_service_artifact_paths`. |
| `project_service::dispatcher::ProjectServiceDispatchResponse::sse_snapshot` | No Node constructor equivalent. | Test convenience constructor; production stream routes use `sse_stream_snapshot` with a stream plan. |
| `project_service::http::project_service_request_headers` | No production Node helper after Rust cutover. | Header normalization is done by the Rust HTTP parser before routing. This helper is a fixture/test builder. |
| `project_service::notifications::upsert_notification` | No production Node caller outside tests; Node production used add/list/mark/clear notification APIs. | Store upsert is contract/test setup only. |
| `project_service::plans::plans_route_prefix` | No production Node helper equivalent. | Route prefix test seam; production routing uses `project_api_contract::routes`. |
| `project_service::process::write_project_service_response` | No Node helper equivalent. | No-context writer wrapper used by tests; production uses `write_project_service_response_with_runtime` so streams can carry request context. |
| `project_service::router::{with_session_label, with_desktop_state}` | No production Node helper equivalent. | Request-context fixture builders; production contexts are constructed from project service process state. |
| `project_service::routes::{display_path, project_service_specs_for}` | No production Node helper equivalent. | Route inventory/contract helpers. Production matching uses the route specs internally. |
| `runtime_guard_repair_history::{load_attempts, record_attempt, clear_attempts}` | Yes for the Node behavior, but Node called it only from dashboard runtime-guard repair UI. | The Rust functions are currently contract-covered and otherwise owned by dashboard/runtime-guard wiring. Route any production wiring decision to the TUI owner. |
| `session_runtime::session_runtime_events` | No current production path after the Rust cutover. | Contract helper for the retired long-lived JS `SessionRuntime` object model. |
| `tmux_exec_metrics::reset_tmux_exec_metrics` | No production Node caller except tests; Node production recorded and read metrics, but reset was a test helper. | Test-only reset seam. |
| `TmuxSessionTransport::{dimensions, on_exit, kill_async, poll_liveness}` | Yes for the old Node `SessionRuntime` transport object model. | The native runtime no longer drives user paths through a persistent `TmuxSessionTransport`. These methods are retained for contract coverage until Sam rules on deleting the old object-model shim. |
| `TmuxRuntimeManager::{send_client_enter, send_client_carriage_return, send_modified_enter}` | Yes for Node tmux input behavior. | Rust production sends these key sequences through direct argv helpers and higher-level tmux/open paths. The manager methods are fixture seams. |

## TUI-Owned Orphans

Triaged after `f7c8b4d8` from `scripts/audit-rust-orphans.mjs` rows marked
`tui-owned`.

### Live Bugs

| Rust symbol | Node called from real user path? | Current Rust gap |
| --- | --- | --- |
| `tui_render::theme::recede` | Yes. Node `src/multiplexer/dashboard-state-methods.ts` dimmed the dashboard base frame with `recede(output)` before drawing any active dashboard overlay. | Fixed in `f7c8b4d8`: Rust dashboard overlay composition now recedes the base frame before appending overlays. Missing behavior before the fix: modals rendered over a bright dashboard instead of the dimmed backdrop Node produced. Mutation proof: replacing `recede(&base.frame)` with `base.frame.clone()` fails `dashboard_overlay_recedes_base_frame_like_node_write_frame`. |

### Node Yes, Rust Behavior Reached Elsewhere

| Rust symbol | Node called from real user path? | Why this orphan is not a live bug |
| --- | --- | --- |
| `DashboardController::set_work_outline_overlay` | Yes for the behavior. Node `showWorkOutlineOverlay()` set session id, zeroed offset, loaded entries, opened the `work-outline` overlay, and rendered it. | Rust production reaches the same behavior through `DashboardControllerEffect::LoadWorkOutlineOverlay` and `dashboard_internal` calling `set_work_outline_overlay_with_offset`. The unreferenced `set_work_outline_overlay` method is the zero-offset convenience wrapper used by tests. |
| `dashboard_controller::parse_dashboard_key` | Yes for dashboard key parsing. Node dashboard input handlers used `parseKeys()` plus `commandKey()` on real terminal bytes. | Rust production calls `parse_dashboard_keys` from `dashboard_terminal::read_dashboard_keys`. The single-key `parse_dashboard_key` wrapper is a test/helper seam; the parser behavior is wired through the multi-key function. |
| `DashboardUiStatePersistence::persist_render_state` | Yes for UI render-state persistence. Node `persistDashboardUiState()` wrote screen, preview source, sidebar visibility, selection, and order state through `DashboardUiStateStore.persist()`. | Rust production calls the richer `persist_controller_state` after dashboard renders. The unreferenced `persist_render_state` method is an older narrow screen+preview helper retained for tests. |
| `ExposePaneOutputTap::track_items` | Yes. Node `ProjectOutputPreviewCoordinator.attachExposePreviewSnapshots()` called `exposePaneOutputTap.trackItems(rawItems)` on project-service preview routes. | Rust reaches the visible `previewSnapshot` behavior through `project_service::preview_snapshots::capture_preview_snapshot`, hot expose snapshots, and direct tmux capture from the desktop-state and switchable-agent routes. The tap-stream implementation remains a dormant optimization path, not the active production preview source after cutover. |
| `tmux_expose::run_tmux_expose_with_client` | Yes for the Expose runner. Node production called `runTmuxExpose()` from the project-service expose socket and popup entrypoint. | Rust production calls `run_tmux_expose` from the real binary entrypoint, which then runs through the same driver pipeline. `run_tmux_expose_with_client` is the dependency-injection wrapper used by tests. |
| `tmux_expose::load_expose_scope_items` | Yes. Node `runTmuxExpose()` called `loadExposeScopeItems()` during initial load, reload, and scope changes. | Rust production calls `load_expose_scope_items_with` from the Expose runner so tests can inject the HTTP client. The public no-client wrapper is unused, but the scope-load behavior is wired. |

### Node No, Dead Or Contract-Only

| Rust symbol | Node called from real user path? | Triage |
| --- | --- | --- |
| `ExposePaneOutputTap::into_tmux` | No production Node equivalent found. | Test accessor for recovering the fake tmux driver from tap fixtures. |
| `ExposePaneOutputTap::tmux_mut` | No production Node equivalent found. | Test accessor for mutating the fake tmux driver in tap fixtures. |
| `ExposePaneOutputTap::compact_tracked_files_for_test` | No production Node equivalent found. | Explicit test-only maintenance hook for tap compaction fixtures. |
| `tui_render::theme::keycap_hint_lines` | No production Node caller found; the recovered Node export was only exercised by `src/tui/render/theme.test.ts`. | Contract-only helper retained for fixture parity. Production footer/help rendering uses the other footer hint renderers. |

## Action List

Do not delete any of the dead candidates until Sam rules on deletion. The
user-visible bugs to wire first are:

1. Runtime guard self-drift: production probe must call the current-manifest
   drift check like Node did.
2. Dashboard shifted-letter key handling: route to the TUI owner.
3. Hosted audit prompt/device persistence and hosted operator streaming: decide
   whether the hosted server
   surface remains product-supported after phase 8.
