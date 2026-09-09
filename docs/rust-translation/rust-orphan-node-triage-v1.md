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
| `TmuxRuntimeManager::has_window` | Yes. Node called `hasWindow` from `src/runtime-restart.ts` to restore active windows and guard killing failed repair dashboards, and from `src/multiplexer/services.ts` when removing an offline service with a saved tmux target. | Rust has the tmux method but no production caller. Missing behavior: restart does not guard stale dashboard targets or restore active non-dashboard windows after reload; offline service removal may also skip the saved-target liveness check. |
| `TmuxRuntimeManager::link_window_to_session` | Yes. Node called `linkWindowToSession` from `relinkDashboardToClientSessions()` during runtime restart. | Rust reloads the host dashboard and reports success, but does not relink the reloaded dashboard window into existing client sessions or clean stale dashboard links. Missing behavior: after repair/restart, client sessions can remain attached to stale or missing dashboard windows. |
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
2. Runtime restart tmux lifecycle: port dashboard relink, stale dashboard link
   cleanup, active-window restore, and pre-restart failed-dashboard kill.
3. Dashboard shifted-letter key handling: route to the TUI owner.
4. Hosted audit prompt/device persistence: decide whether the hosted server
   surface remains product-supported after phase 8.
