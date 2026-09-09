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
