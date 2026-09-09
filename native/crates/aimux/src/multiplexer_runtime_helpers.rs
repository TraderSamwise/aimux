use crate::session_launch::resolve_default_scribe_launch;
use crate::tool_output_watchers::{ToolPaneState, reconcile_agent_activity};
use crate::tui_render::text::{
    strip_ansi, truncate_ansi, truncate_plain, wrap_key_value, wrap_text,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};

const RUNTIME_GUARD_REPAIR_FLAP_WINDOW_MS: i64 = 120_000;
const TARGET_METADATA_STARTUP_GRACE_MS: i64 = 5_000;
const FIXED_NOW_MS: i64 = 1_700_000_000_000;

pub fn run_multiplexer_runtime_helpers_contract_case(api: &str, input: &Value) -> Value {
    match api {
        "dashboardProjectRoot" => dashboard_project_root_case(input),
        "pruneRuntimeGuardRepairAttempts" => prune_runtime_guard_repair_attempts_case(input),
        "startRuntimeGuardRepair" => start_runtime_guard_repair_case(input),
        "handleDashboardSubscreenNavigationKey" => {
            handle_dashboard_subscreen_navigation_key_case(input)
        }
        "renderSessionDetails+textHelpers" => render_session_details_case(input),
        "resolveDefaultScribeLaunch" => resolve_default_scribe_launch_case(input),
        "deriveAimuxSessionIdFromBackendSessionId+summarizeLaunchArgs+injectCodexDeveloperInstructions" => {
            session_launch_helpers_case(input)
        }
        "getSessionsByWorktree+getScopedSessionEntries+getSessionWorktreePath" => {
            session_worktree_helpers_case(input)
        }
        "getSessionLabel+applySessionLabel+applyDashboardSessionLabel" => {
            session_label_helpers_case(input)
        }
        "stripSgr+reconcileAgentActivity+resolveRunningSession" => {
            session_runtime_core_helpers_case(input)
        }
        "resolveLiveSessionTmuxTarget" => resolve_live_session_tmux_target_case(input),
        "updateContextWatcherSessions" => update_context_watcher_sessions_case(input),
        "registerManagedSession" => register_managed_session_case(input),
        "handleSessionRuntimeEvent" => handle_session_runtime_event_case(input),
        "attentionScore+getPreferredThreadIndexForParticipant+describeHandoffState" => {
            subscreen_attention_helpers_case(input)
        }
        api => panic!("unknown multiplexer runtime helper api: {api}"),
    }
}

fn dashboard_project_root_case(input: &Value) -> Value {
    Value::Array(
        array_field(input, "hosts")
            .iter()
            .map(|host| {
                let project_root = host
                    .get("projectRoot")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim();
                Value::String(if project_root.is_empty() {
                    "<REPO>".into()
                } else {
                    project_root.to_owned()
                })
            })
            .collect(),
    )
}

fn prune_runtime_guard_repair_attempts_case(input: &Value) -> Value {
    let now = input.get("now").and_then(Value::as_i64).unwrap_or_default();
    Value::Array(
        array_field(input, "attempts")
            .iter()
            .filter_map(Value::as_i64)
            .filter(|attempt| now - *attempt < RUNTIME_GUARD_REPAIR_FLAP_WINDOW_MS)
            .map(Value::from)
            .collect(),
    )
}

fn start_runtime_guard_repair_case(input: &Value) -> Value {
    Value::Array(
        array_field(input, "scenarios")
            .iter()
            .map(|scenario| {
                let name = scenario.get("name").cloned().unwrap_or(Value::Null);
                let runtime_guard_repairing = bool_field(scenario, "runtimeGuardRepairing");
                let mut host = json!({
                    "runtimeGuardRepairing": runtime_guard_repairing,
                    "runtimeGuardRepairBusy": bool_field(scenario, "runtimeGuardRepairBusy"),
                    "runtimeGuardRepairFailedKey": scenario.get("runtimeGuardRepairFailedKey").cloned().unwrap_or(Value::Null),
                    "runtimeGuardRepairRetryAt": scenario.get("runtimeGuardRepairRetryAt").cloned().unwrap_or(Value::Null),
                    "runtimeGuardRepairBlockedNoticeAt": Value::Null,
                    "dashboardBusyState": scenario.get("dashboardBusyState").cloned().unwrap_or(Value::Null),
                    "dashboardErrorState": scenario.get("dashboardErrorState").cloned().unwrap_or(Value::Null),
                    "footerFlash": Value::Null,
                    "footerFlashTicks": Value::Null,
                    "dashboardRepairNotices": [],
                    "runtimeGuardRepairAttempts": [],
                });
                let mut calls = Vec::new();
                let state = value_field(scenario, "state");
                let state_kind = string_field(state, "kind");
                let repair_key = if state_kind == "stale" {
                    format!("stale:{}", string_field(state, "reason"))
                } else {
                    state_kind.clone()
                };
                let eligible = state_kind == "stale" || state_kind == "runtime-rebuild-required";
                let retry_blocked = scenario
                    .get("runtimeGuardRepairFailedKey")
                    .and_then(Value::as_str)
                    == Some(repair_key.as_str())
                    && scenario
                        .get("runtimeGuardRepairRetryAt")
                        .and_then(Value::as_i64)
                        .is_some_and(|retry_at| FIXED_NOW_MS < retry_at);

                if eligible
                    && !runtime_guard_repairing
                    && !bool_field(scenario, "runtimeGuardRepairTimedOutPending")
                    && !retry_blocked
                {
                    let seed_attempts = array_field(scenario, "seedAttempts");
                    if seed_attempts.len() >= 5 {
                        host["runtimeGuardRepairAttempts"] = Value::Array(seed_attempts);
                        calls.push(call(
                            "showDashboardError",
                            vec![
                                json!("Aimux repair is looping"),
                                json!([
                                    "Repaired 5 times in 120s without settling \u{2014} stopping. This dashboard is likely running an older build than the daemon; reload it."
                                ]),
                            ],
                        ));
                    } else if bool_field(scenario, "runtimeRestartLock") {
                        host["runtimeGuardRepairBusy"] = json!(true);
                        host["runtimeGuardRepairBlockedNoticeAt"] = json!(FIXED_NOW_MS);
                        host["footerFlash"] = json!("Aimux repair already running");
                        host["footerFlashTicks"] = json!(3);
                        host["dashboardRepairNotices"] = json!([
                            {
                                "kind": "runtime-guard-repair",
                                "phase": "blocked",
                                "message": "Aimux repair already running",
                                "at": FIXED_NOW_MS,
                            }
                        ]);
                        calls.push(call("renderCurrentDashboardView", vec![]));
                    }
                }

                json!({
                    "name": name,
                    "host": host,
                    "calls": calls,
                })
            })
            .collect(),
    )
}

fn handle_dashboard_subscreen_navigation_key_case(input: &Value) -> Value {
    Value::Array(
        array_field(input, "scenarios")
            .iter()
            .map(|scenario| {
                let current_screen = string_field(scenario, "currentScreen");
                let key = string_field(scenario, "key");
                let shifted = value_field(scenario, "event")
                    .get("shift")
                    .and_then(Value::as_bool)
                    == Some(true);
                let mut calls = Vec::new();
                let mut screen = current_screen.clone();
                let handled = match key.as_str() {
                    "d" if current_screen != "dashboard" && !shifted => {
                        screen = "dashboard".into();
                        calls.extend([
                            call("dashboardState.setScreen", vec![json!("dashboard")]),
                            call("writeDashboardClientStatuslineFile", vec![]),
                            call("persistDashboardUiState", vec![]),
                            call("tmuxRuntimeManager.refreshStatus", vec![]),
                            call("renderDashboard", vec![]),
                        ]);
                        true
                    }
                    "c" if current_screen != "coordination" && !shifted => {
                        calls.push(call("showCoordination", vec![]));
                        true
                    }
                    "p" if current_screen != "project" && !shifted => {
                        calls.push(call("showProject", vec![]));
                        true
                    }
                    "l" if current_screen != "library" && !shifted => {
                        calls.push(call("showLibrary", vec![]));
                        true
                    }
                    "t" if current_screen != "topology" && !shifted => {
                        calls.push(call("showTopology", vec![]));
                        true
                    }
                    "g" if current_screen != "graveyard" && !shifted => {
                        calls.push(call("showGraveyard", vec![]));
                        true
                    }
                    _ => false,
                };
                json!({
                    "scenario": scenario,
                    "handled": handled,
                    "screen": screen,
                    "calls": calls,
                })
            })
            .collect(),
    )
}

fn render_session_details_case(input: &Value) -> Value {
    let session = value_field(input, "session");
    let width = input.get("width").and_then(Value::as_u64).unwrap_or(0) as usize;
    let height = input.get("height").and_then(Value::as_u64).unwrap_or(0) as usize;
    let details = render_session_details(session, width, height);
    json!({
        "details": details,
        "wrapKeyValue": wrap_key_value("Path", "/repo/.aimux/worktrees/feature/subdir", 32),
        "wrapText": wrap_text(&string_field(input, "text"), 18),
        "truncatePlain": truncate_plain(&string_field(input, "text"), 24),
        "truncateAnsi": truncate_ansi(&string_field(input, "ansi"), 12),
        "basename": basename_for_host("/repo/.aimux/worktrees/feature"),
    })
}

fn resolve_default_scribe_launch_case(input: &Value) -> Value {
    Value::Array(
        array_field(input, "configs")
            .iter()
            .map(resolve_default_scribe_launch)
            .collect(),
    )
}

fn session_launch_helpers_case(input: &Value) -> Value {
    json!({
        "ids": array_field(input, "backendCases")
            .iter()
            .map(|case| Value::String(derive_aimux_session_id_from_backend_session_id(
                &string_field(case, "command"),
                &string_field(case, "backendSessionId"),
                &array_field(case, "existingIds")
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<BTreeSet<_>>(),
            )))
            .collect::<Vec<_>>(),
        "summarized": summarize_launch_args(&array_field(input, "launchArgs")),
        "summarizedEdge": summarize_launch_args(&array_field(input, "launchArgsEdge")),
        "injected": inject_codex_developer_instructions(
            &array_field(input, "codexArgs"),
            &string_field(input, "developerKey"),
            &string_field(input, "instructions"),
        ),
        "injectedBeforeDash": inject_codex_developer_instructions(
            &array_field(input, "codexArgsDash"),
            &string_field(input, "developerKey"),
            &string_field(input, "instructions"),
        ),
        "injectedAfterShortOptions": inject_codex_developer_instructions(
            &array_field(input, "codexArgsShort"),
            &string_field(input, "developerKey"),
            &string_field(input, "instructions"),
        ),
        "injectedWithoutPositional": inject_codex_developer_instructions(
            &array_field(input, "codexArgsNoPositional"),
            &string_field(input, "developerKey"),
            &string_field(input, "instructions"),
        ),
        "blankInjection": inject_codex_developer_instructions(
            &array_field(input, "codexArgs"),
            "",
            &string_field(input, "instructions"),
        ),
        "blankInstructionsInjection": inject_codex_developer_instructions(
            &array_field(input, "codexArgs"),
            &string_field(input, "developerKey"),
            "  ",
        ),
    })
}

fn session_worktree_helpers_case(input: &Value) -> Value {
    let sessions = array_field(input, "sessions");
    let worktrees = worktree_pairs(input);
    let groups = sessions_by_worktree(&sessions, &worktrees);
    json!({
        "worktreePath": worktrees.get("codex-1").cloned().unwrap_or_default(),
        "groups": groups
            .into_iter()
            .map(|(path, ids)| json!({ "path": path, "ids": ids }))
            .collect::<Vec<_>>(),
        "scoped": sessions
            .iter()
            .enumerate()
            .filter(|(_, session)| !is_project_control_session(session))
            .map(|(index, session)| json!({
                "id": string_field(session, "id"),
                "index": index,
            }))
            .collect::<Vec<_>>(),
    })
}

fn session_label_helpers_case(input: &Value) -> Value {
    let mut labels = map_from_pairs(value_field(input, "sessionLabels"));
    let mut offline_sessions = array_field(input, "offlineSessions");
    let mut dashboard_sessions_cache = array_field(input, "dashboardSessionsCache");
    let mut dashboard_worktree_groups_cache = array_field(input, "dashboardWorktreeGroupsCache");
    let mut dashboard_state = value_field(input, "dashboardState").clone();

    let before = json!({
        "live": get_session_label("live-1", &labels, &offline_sessions),
        "offline": get_session_label("offline-1", &labels, &offline_sessions),
        "missing": get_session_label("missing-1", &labels, &offline_sessions),
    });
    apply_session_label(
        "offline-1",
        "  New Offline  ",
        &mut labels,
        &mut offline_sessions,
    );
    apply_session_label("live-1", " ", &mut labels, &mut offline_sessions);
    apply_dashboard_session_label(
        "live-1",
        "  New Dashboard  ",
        &mut dashboard_sessions_cache,
        &mut dashboard_worktree_groups_cache,
        &mut dashboard_state,
    );

    json!({
        "before": before,
        "labels": labels,
        "offlineSessions": offline_sessions,
        "dashboardSessionsCache": dashboard_sessions_cache,
        "dashboardWorktreeGroupsCache": dashboard_worktree_groups_cache,
        "dashboardState": dashboard_state,
    })
}

fn session_runtime_core_helpers_case(input: &Value) -> Value {
    let sessions = array_field(input, "sessions");
    let activities = array_field(input, "activityCases")
        .iter()
        .map(|case| {
            let pane_state = tool_pane_state_from_contract(value_field(case, "paneState"));
            serde_json::to_value(reconcile_agent_activity(
                case.get("reported").and_then(Value::as_str),
                case.get("activityText").and_then(Value::as_str),
                &pane_state,
            ))
            .expect("activity state serializes")
        })
        .collect::<Vec<_>>();
    let resolve = ["live-1", "exited-1", "missing-1"]
        .iter()
        .map(|id| resolve_running_session(&sessions, id))
        .collect::<Vec<_>>();
    json!({
        "stripped": strip_ansi(&string_field(input, "text")),
        "activities": activities,
        "resolve": resolve,
    })
}

fn resolve_live_session_tmux_target_case(input: &Value) -> Value {
    Value::Array(
        array_field(input, "scenarios")
            .iter()
            .map(|scenario| {
                let mut state = RuntimeCoreTargetState::new(scenario);
                let result = state.resolve_live_session_tmux_target(
                    &string_field(scenario, "sessionId"),
                    scenario.get("fallback"),
                );
                json!({
                    "name": string_field(scenario, "name"),
                    "result": result.unwrap_or(Value::Null),
                    "sessionTmuxTargets": state.targets_json(),
                    "calls": state.calls,
                })
            })
            .collect(),
    )
}

fn update_context_watcher_sessions_case(input: &Value) -> Value {
    Value::Array(
        array_field(input, "scenarios")
            .iter()
            .map(|scenario| {
                let mut state = RuntimeCoreTargetState::new(scenario);
                let updates = vec![
                    array_field(scenario, "sessions")
                        .iter()
                        .map(|session| {
                            let session_id = string_field(session, "id");
                            let mut entry = serde_json::Map::new();
                            entry.insert("id".into(), Value::String(session_id.clone()));
                            entry.insert(
                                "command".into(),
                                Value::String(string_field(session, "command")),
                            );
                            if let Some(patterns) = turn_patterns_for_session(scenario, &session_id)
                            {
                                entry.insert(
                                    "turnPatterns".into(),
                                    Value::Array(patterns.into_iter().map(Value::String).collect()),
                                );
                            }
                            entry.insert(
                                "tmuxTarget".into(),
                                state
                                    .resolve_live_session_tmux_target(&session_id, None)
                                    .unwrap_or(Value::Null),
                            );
                            Value::Object(entry)
                        })
                        .collect::<Vec<_>>(),
                ];
                state.call("contextWatcher.start", vec![]);
                json!({
                    "name": string_field(scenario, "name"),
                    "updates": updates,
                    "sessionTmuxTargets": state.targets_json(),
                    "calls": state.calls,
                })
            })
            .collect(),
    )
}

fn register_managed_session_case(input: &Value) -> Value {
    Value::Array(
        array_field(input, "scenarios")
            .iter()
            .map(register_managed_session_scenario)
            .collect(),
    )
}

fn register_managed_session_scenario(scenario: &Value) -> Value {
    let mut calls = Vec::new();
    let transport = value_field(scenario, "transport");
    let mut sessions = array_field(scenario, "sessions");
    let mut tool_keys = value_map_from_pairs(value_field(scenario, "sessionToolKeys"));
    let mut original_args = value_map_from_pairs(value_field(scenario, "sessionOriginalArgs"));
    let mut worktree_paths = value_map_from_pairs(value_field(scenario, "sessionWorktreePaths"));
    let mut roles = value_map_from_pairs(value_field(scenario, "sessionRoles"));
    let mut labels = value_map_from_pairs(value_field(scenario, "sessionLabels"));
    let returned_existing = scenario.get("expectExisting").and_then(Value::as_bool) == Some(true);
    let session_id = string_field(transport, "id");
    let mut runtime = serde_json::Map::new();

    if returned_existing {
        runtime.insert("id".into(), Value::String(session_id.clone()));
        runtime.insert("backendSessionId".into(), Value::Null);
        runtime.insert("startTime".into(), Value::Null);
        runtime.insert("team".into(), Value::Null);
    } else {
        if let Some(tool_config_key) = transport_string(scenario, "toolConfigKey") {
            tool_keys.insert(session_id.clone(), Value::String(tool_config_key));
        }
        original_args.insert(session_id.clone(), value_field(scenario, "args").clone());
        if let Some(worktree_path) = transport_string(scenario, "worktreePath") {
            worktree_paths.insert(session_id.clone(), Value::String(worktree_path));
        }
        if !value_field(scenario, "team").is_null() {
            roles.remove(&session_id);
        } else if let Some(role) = transport_string(scenario, "role") {
            roles.insert(session_id.clone(), Value::String(role));
        }
        if let Some(label) = array_field(scenario, "offlineSessions")
            .iter()
            .find(|session| string_field(session, "id") == session_id)
            .and_then(|session| session.get("label").cloned())
        {
            labels.insert(session_id.clone(), label);
        }
        sessions.push(json!({ "id": session_id }));
        calls.push(call("updateContextWatcherSessions", vec![]));
        if sessions.len() == 1 {
            calls.push(call("contextWatcher.start", vec![]));
        }
        if let Some(data) = scenario.get("emitData").and_then(Value::as_str) {
            calls.push(call(
                "handleSessionRuntimeEvent",
                vec![
                    Value::String(session_id.clone()),
                    json!({ "type": "output", "data": data }),
                ],
            ));
        }
        if let Some(code) = scenario.get("emitExitCode").and_then(Value::as_i64) {
            calls.push(call(
                "handleSessionRuntimeEvent",
                vec![
                    Value::String(session_id.clone()),
                    json!({ "type": "exit", "code": code }),
                ],
            ));
        }
        runtime.insert("id".into(), Value::String(session_id.clone()));
        runtime.insert(
            "command".into(),
            Value::String(string_field(transport, "command")),
        );
        runtime.insert(
            "backendSessionId".into(),
            transport
                .get("backendSessionId")
                .cloned()
                .unwrap_or(Value::Null),
        );
        runtime.insert(
            "status".into(),
            Value::String(string_or_literal(transport, "status", "running")),
        );
        runtime.insert(
            "startTime".into(),
            scenario.get("startTime").cloned().unwrap_or(Value::Null),
        );
        runtime.insert("team".into(), value_field(scenario, "team").clone());
    }

    json!({
        "name": string_field(scenario, "name"),
        "returnedExisting": returned_existing,
        "runtime": Value::Object(runtime),
        "sessions": sessions.iter().map(|session| Value::String(string_field(session, "id"))).collect::<Vec<_>>(),
        "sessionToolKeys": Value::Object(tool_keys.into_iter().collect()),
        "sessionOriginalArgs": Value::Object(original_args.into_iter().collect()),
        "sessionWorktreePaths": Value::Object(worktree_paths.into_iter().collect()),
        "sessionRoles": Value::Object(roles.into_iter().collect()),
        "sessionLabels": Value::Object(labels.into_iter().collect()),
        "calls": calls,
    })
}

fn handle_session_runtime_event_case(input: &Value) -> Value {
    Value::Array(
        array_field(input, "scenarios")
            .iter()
            .map(handle_session_runtime_event_scenario)
            .collect(),
    )
}

fn handle_session_runtime_event_scenario(scenario: &Value) -> Value {
    let runtime = value_field(scenario, "runtime");
    let host = value_field(scenario, "host");
    let event = value_field(scenario, "event");
    let session_id = string_field(runtime, "id");
    let command = string_field(runtime, "command");
    let mut calls = Vec::new();
    let mut sessions = vec![Value::String(session_id.clone())];
    sessions.extend(
        array_field(host, "extraSessions")
            .iter()
            .map(|session| Value::String(string_field(session, "id"))),
    );
    let mut stopping = string_set_from_array(value_field(host, "stoppingSessionIds"));
    let mut graveyard = string_set_from_array(value_field(host, "graveyardAfterStopSessionIds"));
    let mut target_map = value_map_from_pairs(value_field(host, "sessionTmuxTargets"));
    let mut footer_flash = Value::Null;
    let mut footer_flash_ticks = Value::Null;
    let mut unpreserved = BTreeSet::new();
    let mut topology = Vec::new();
    let mut active_index = host
        .get("activeIndex")
        .and_then(Value::as_i64)
        .unwrap_or_default();

    if event.get("type").and_then(Value::as_str) == Some("output") {
        calls.push(call("writeStatuslineFile", vec![]));
    } else if event.get("type").and_then(Value::as_str) == Some("exit") {
        let code = event
            .get("code")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        calls.push(call(
            "debug",
            vec![
                Value::String(format!("session exited: {session_id} (code={code})")),
                Value::String("session".into()),
            ],
        ));
        let start_time = runtime.get("startTime").and_then(Value::as_i64);
        let uptime = start_time.map_or(i64::MAX, |start| FIXED_NOW_MS - start);
        if code != 0 && uptime < 10_000 {
            footer_flash = Value::String(format!("✗ {session_id} crashed (code {code})"));
            footer_flash_ticks = Value::from(8);
            calls.push(call(
                "debug",
                vec![
                    Value::String(format!(
                        "quick crash: {session_id} (code={code}, uptime={uptime}ms)"
                    )),
                    Value::String("session".into()),
                ],
            ));
            calls.push(call(
                "publishAlert",
                vec![json!({
                    "kind": "task_failed",
                    "sessionId": session_id,
                    "title": format!("{session_id} failed"),
                    "message": format!("Agent exited with code {code}."),
                    "dedupeKey": format!("exit-failed:{session_id}"),
                    "cooldownMs": 15_000,
                })],
            ));
        }
        let explicit_stop = stopping.contains(&session_id);
        let graveyard_after_stop = graveyard.contains(&session_id);
        let backend_session_id = runtime.get("backendSessionId").and_then(Value::as_str);
        let restore_uptime = runtime
            .get("restoreStartedAt")
            .and_then(Value::as_i64)
            .map_or(i64::MAX, |started| FIXED_NOW_MS - started);
        let restore_exited_during_probe =
            !explicit_stop && !graveyard_after_stop && restore_uptime < 30_000;
        let quick_unexpected_exit = !explicit_stop && !graveyard_after_stop && uptime < 10_000;
        let should_preserve = !graveyard_after_stop
            && (explicit_stop
                || backend_session_id.is_some()
                || uptime >= 10_000
                || restore_exited_during_probe);
        if should_preserve {
            let mut session = serde_json::Map::new();
            let tool_config_key = map_value(host, "sessionToolKeys", &session_id)
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_else(|| command.clone());
            session.insert("id".into(), Value::String(session_id.clone()));
            session.insert("tool".into(), Value::String(command.clone()));
            session.insert("toolConfigKey".into(), Value::String(tool_config_key));
            session.insert("command".into(), Value::String(command.clone()));
            session.insert(
                "args".into(),
                map_value(host, "sessionOriginalArgs", &session_id).unwrap_or_else(|| json!([])),
            );
            session.insert("status".into(), Value::String("offline".into()));
            session.insert("lifecycle".into(), Value::String("offline".into()));
            if let Some(start_time) = start_time {
                session.insert("createdAt".into(), Value::String(iso_from_ms(start_time)));
            }
            session.insert("updatedAt".into(), Value::String("<NOW>".into()));
            insert_optional_string(
                &mut session,
                "backendSessionId",
                backend_session_id.map(str::to_owned),
            );
            if let Some(team) = runtime.get("team")
                && !team.is_null()
            {
                session.insert("team".into(), team.clone());
            }
            insert_optional_value(
                &mut session,
                "worktreePath",
                map_value(host, "sessionWorktreePaths", &session_id),
            );
            session.insert(
                "freshRelaunchAllowed".into(),
                Value::Bool(fresh_relaunch_allowed(
                    &command,
                    backend_session_id,
                    quick_unexpected_exit,
                )),
            );
            if restore_exited_during_probe {
                session.insert(
                    "restoreBlockedReason".into(),
                    Value::String("agent exited after restore".into()),
                );
            } else if quick_unexpected_exit {
                session.insert(
                    "restoreBlockedReason".into(),
                    Value::String("agent exited during startup".into()),
                );
            }
            topology.push(Value::Object(session));
            calls.push(call(
                "getSessionLabel",
                vec![Value::String(session_id.clone())],
            ));
            calls.push(call(
                "deriveHeadline",
                vec![Value::String(session_id.clone())],
            ));
        } else {
            unpreserved.insert(session_id.clone());
        }
        sessions.retain(|id| id.as_str() != Some(session_id.as_str()));
        stopping.remove(&session_id);
        graveyard.remove(&session_id);
        target_map.remove(&session_id);
        if should_preserve {
            calls.push(call("loadOfflineTopologySessions", vec![]));
        }
        calls.push(call("updateContextWatcherSessions", vec![]));
        calls.push(call("saveState", vec![]));
        if sessions.is_empty() {
            if host.get("startedInDashboard").and_then(Value::as_bool) == Some(true) {
                calls.push(call("renderDashboard", vec![]));
            } else if host.get("mode").and_then(Value::as_str) != Some("project-service") {
                calls.push(call("resolveRun", vec![Value::from(code)]));
            }
        } else {
            if active_index >= sessions.len() as i64 {
                active_index = sessions.len() as i64 - 1;
            }
            calls.push(call("renderDashboard", vec![]));
        }
    }

    json!({
        "name": string_field(scenario, "name"),
        "sessions": sessions,
        "offlineSessions": array_field(host, "offlineSessions"),
        "stoppingSessionIds": stopping.into_iter().map(Value::String).collect::<Vec<_>>(),
        "graveyardAfterStopSessionIds": graveyard.into_iter().map(Value::String).collect::<Vec<_>>(),
        "sessionTmuxTargets": Value::Object(target_map.into_iter().collect()),
        "activeIndex": active_index,
        "footerFlash": footer_flash,
        "footerFlashTicks": footer_flash_ticks,
        "unpreservedExitedSessionIds": unpreserved.into_iter().map(Value::String).collect::<Vec<_>>(),
        "topology": topology,
        "calls": calls,
    })
}

fn subscreen_attention_helpers_case(input: &Value) -> Value {
    let scores = array_field(input, "attentionInputs")
        .iter()
        .map(attention_score)
        .collect::<Vec<_>>();
    let handoff_states = array_field(input, "handoffs")
        .iter()
        .map(describe_handoff_state)
        .collect::<Vec<_>>();
    json!({
        "scores": scores,
        "preferredIndex": preferred_thread_index(&string_field(input, "participant"), &array_field(input, "entries")),
        "missingIndex": preferred_thread_index("missing-1", &array_field(input, "entries")),
        "handoffStates": handoff_states,
    })
}

fn render_session_details(session: &Value, width: usize, height: usize) -> Vec<String> {
    let mut lines = vec!["\x1b[1mDetails\x1b[0m".to_owned()];
    push_key_value(
        &mut lines,
        "Agent",
        string_or(session, "label", "command"),
        width,
    );
    push_key_value(
        &mut lines,
        "Canonical",
        string_or(session, "toolConfigKey", "command"),
        width,
    );
    push_key_value(&mut lines, "Aimux ID", string_field(session, "id"), width);
    if has_string(session, "backendSessionId") {
        push_key_value(
            &mut lines,
            "Backend ID",
            string_field(session, "backendSessionId"),
            width,
        );
    }
    if string_field(session, "command") != string_or(session, "toolConfigKey", "command") {
        push_key_value(
            &mut lines,
            "Command",
            string_field(session, "command"),
            width,
        );
    }
    if has_string(session, "worktreeName") || has_string(session, "worktreeBranch") {
        let mut worktree = string_or_literal(session, "worktreeName", "main");
        if has_string(session, "worktreeBranch") {
            worktree.push_str(" · ");
            worktree.push_str(&string_field(session, "worktreeBranch"));
        }
        push_key_value(&mut lines, "Worktree", worktree, width);
    }
    for key in ["cwd", "prUrl"] {
        if has_string(session, key) {
            let label = match key {
                "cwd" => "CWD",
                "prUrl" => "URL",
                _ => "URL",
            };
            push_key_value(&mut lines, label, string_field(session, key), width);
        }
    }
    if session.get("prNumber").is_some()
        || has_string(session, "prTitle")
        || has_string(session, "prUrl")
    {
        let mut pr = format!(
            "PR #{}",
            session
                .get("prNumber")
                .and_then(Value::as_i64)
                .unwrap_or_default()
        );
        if has_string(session, "prTitle") {
            pr.push_str(": ");
            pr.push_str(&string_field(session, "prTitle"));
        }
        let insert_at = lines
            .iter()
            .position(|line| line.starts_with("URL: "))
            .unwrap_or(lines.len());
        lines.splice(insert_at..insert_at, wrap_key_value("PR", &pr, width));
    }
    if has_string(session, "repoOwner") || has_string(session, "repoName") {
        push_key_value(
            &mut lines,
            "Repo",
            format!(
                "{}/{}",
                string_or_literal(session, "repoOwner", "?"),
                string_or_literal(session, "repoName", "?")
            ),
            width,
        );
    }
    if has_string(session, "repoRemote") {
        push_key_value(
            &mut lines,
            "Remote",
            string_field(session, "repoRemote"),
            width,
        );
    }
    let semantic = value_field(session, "semantic");
    if !semantic.is_null() {
        push_key_value(
            &mut lines,
            "State",
            value_field(value_field(semantic, "presentation"), "statusLabel")
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            width,
        );
        let attention = value_field(value_field(semantic, "user"), "attention")
            .as_str()
            .unwrap_or("none");
        if attention != "none" {
            push_key_value(&mut lines, "Attention", attention.to_owned(), width);
        }
        let notifications = value_field(semantic, "notifications");
        if notifications
            .get("unreadCount")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            > 0
        {
            push_key_value(
                &mut lines,
                "Unread",
                notifications
                    .get("unreadCount")
                    .and_then(Value::as_i64)
                    .unwrap_or_default()
                    .to_string(),
                width,
            );
        }
        if has_string(notifications, "latestText") {
            push_key_value(
                &mut lines,
                "Latest",
                string_field(notifications, "latestText"),
                width,
            );
        }
        if semantic
            .get("activityNewCount")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            > 0
        {
            push_key_value(
                &mut lines,
                "New activity",
                semantic
                    .get("activityNewCount")
                    .and_then(Value::as_i64)
                    .unwrap_or_default()
                    .to_string(),
                width,
            );
        }
    }
    if has_string(value_field(session, "lastEvent"), "message") {
        push_key_value(
            &mut lines,
            "Last",
            string_field(value_field(session, "lastEvent"), "message"),
            width,
        );
    }
    while lines.len() < height {
        lines.push(String::new());
    }
    lines.truncate(height);
    lines
}

fn derive_aimux_session_id_from_backend_session_id(
    command: &str,
    backend_session_id: &str,
    existing_ids: &BTreeSet<String>,
) -> String {
    let command_executable = basename_for_host(command);
    let slug = backend_session_id_slug(backend_session_id);
    for length in 6.min(slug.len())..=16.min(slug.len()) {
        let candidate = format!("{}-{}", command_executable, &slug[..length]);
        if !existing_ids.contains(&candidate) {
            return candidate;
        }
    }
    let suffix = hex_sha256(backend_session_id)
        .chars()
        .take(8)
        .collect::<String>();
    let fallback_base = format!(
        "{}-{}-{}",
        command_executable,
        &slug[..6.min(slug.len())],
        suffix
    );
    if !existing_ids.contains(&fallback_base) {
        return fallback_base;
    }
    let mut counter = 2;
    loop {
        let candidate = format!("{fallback_base}-{counter}");
        if !existing_ids.contains(&candidate) {
            return candidate;
        }
        counter += 1;
    }
}

fn backend_session_id_slug(backend_session_id: &str) -> String {
    let normalized = backend_session_id
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>();
    if normalized.is_empty() {
        hex_sha256(backend_session_id)
    } else {
        normalized
    }
}

fn summarize_launch_args(args: &[Value]) -> Vec<Value> {
    let mut redact_next = false;
    args.iter()
        .filter_map(Value::as_str)
        .map(|arg| {
            if redact_next {
                redact_next = false;
                return Value::String("<redacted>".into());
            }
            let summarized = summarize_launch_arg(arg);
            redact_next = sensitive_option_arg(arg) && !arg.contains('=');
            Value::String(summarized)
        })
        .collect()
}

fn summarize_launch_arg(arg: &str) -> String {
    if let Some(index) = arg.find('=')
        && (sensitive_option_arg(&arg[..index]) || sensitive_env_arg(&arg[..index]))
    {
        return format!("{}=<redacted>", &arg[..index]);
    }
    if arg.chars().count() > 100 {
        format!("{}...", arg.chars().take(100).collect::<String>())
    } else {
        arg.to_owned()
    }
}

fn inject_codex_developer_instructions(
    args: &[Value],
    key: &str,
    instructions: &str,
) -> Vec<Value> {
    let args = args
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if key.trim().is_empty() || instructions.trim().is_empty() {
        return args.into_iter().map(Value::String).collect();
    }
    let index = first_codex_positional_arg_index(&args);
    let mut out = Vec::new();
    out.extend(args[..index].iter().cloned().map(Value::String));
    out.push(Value::String("-c".into()));
    out.push(Value::String(format!(
        "{}={}",
        key,
        serde_json::to_string(instructions).expect("serialize instructions")
    )));
    out.extend(args[index..].iter().cloned().map(Value::String));
    out
}

fn first_codex_positional_arg_index(args: &[String]) -> usize {
    let mut skip_next = false;
    for (index, arg) in args.iter().enumerate() {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--" {
            return index;
        }
        if arg.starts_with("--") {
            let (name, has_value) = arg
                .split_once('=')
                .map(|(name, _)| (name, true))
                .unwrap_or((arg, false));
            if codex_option_with_value(name) && !has_value {
                skip_next = true;
            }
            continue;
        }
        if arg.starts_with('-') {
            if codex_option_with_value(arg) {
                skip_next = true;
            }
            continue;
        }
        return index;
    }
    args.len()
}

fn sessions_by_worktree(
    sessions: &[Value],
    worktrees: &BTreeMap<String, String>,
) -> Vec<(Option<String>, Vec<String>)> {
    let mut groups = Vec::<(Option<String>, Vec<String>)>::new();
    for session in sessions {
        let id = string_field(session, "id");
        let path = worktrees.get(&id).cloned();
        if let Some((_, ids)) = groups.iter_mut().find(|(existing, _)| existing == &path) {
            ids.push(id);
        } else {
            groups.push((path, vec![id]));
        }
    }
    groups
}

fn get_session_label(
    session_id: &str,
    labels: &BTreeMap<String, String>,
    offline_sessions: &[Value],
) -> Value {
    if let Some(label) = labels.get(session_id) {
        return Value::String(label.clone());
    }
    offline_sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
        .and_then(|session| session.get("label").and_then(Value::as_str))
        .map(|label| Value::String(label.to_owned()))
        .unwrap_or(Value::Null)
}

fn apply_session_label(
    session_id: &str,
    label: &str,
    labels: &mut BTreeMap<String, String>,
    offline_sessions: &mut [Value],
) {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        labels.remove(session_id);
    } else {
        labels.insert(session_id.to_owned(), trimmed.to_owned());
    }
    for session in offline_sessions {
        if session.get("id").and_then(Value::as_str) != Some(session_id) {
            continue;
        }
        if let Some(object) = session.as_object_mut() {
            if trimmed.is_empty() {
                object.remove("label");
            } else {
                object.insert("label".into(), Value::String(trimmed.to_owned()));
            }
        }
    }
}

fn apply_dashboard_session_label(
    session_id: &str,
    label: &str,
    dashboard_sessions_cache: &mut [Value],
    dashboard_worktree_groups_cache: &mut [Value],
    dashboard_state: &mut Value,
) {
    let trimmed = label.trim();
    apply_label_to_sessions(dashboard_sessions_cache, session_id, trimmed);
    for group in dashboard_worktree_groups_cache {
        if let Some(sessions) = group.get_mut("sessions").and_then(Value::as_array_mut) {
            apply_label_to_sessions(sessions, session_id, trimmed);
        }
    }
    if let Some(sessions) = dashboard_state
        .get_mut("worktreeSessions")
        .and_then(Value::as_array_mut)
    {
        apply_label_to_sessions(sessions, session_id, trimmed);
    }
}

fn apply_label_to_sessions(sessions: &mut [Value], session_id: &str, label: &str) {
    for session in sessions {
        if session.get("id").and_then(Value::as_str) != Some(session_id) {
            continue;
        }
        if let Some(object) = session.as_object_mut() {
            if label.is_empty() {
                object.remove("label");
            } else {
                object.insert("label".into(), Value::String(label.to_owned()));
            }
        }
    }
}

fn tool_pane_state_from_contract(value: &Value) -> ToolPaneState {
    ToolPaneState {
        prompt_visible: value
            .get("promptVisible")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        error_visible: value
            .get("errorVisible")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        interrupted_visible: value
            .get("interruptedVisible")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        update_prompt_visible: value
            .get("updatePromptVisible")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        blocked_message: value
            .get("blockedMessage")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

fn resolve_running_session(sessions: &[Value], session_id: &str) -> Value {
    let session = sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id));
    if let Some(session) = session
        && session.get("exited").and_then(Value::as_bool) != Some(true)
    {
        return json!({ "ok": true, "value": session_id });
    }
    json!({ "ok": false, "error": format!("Session \"{session_id}\" is not running") })
}

fn attention_score(entry: &Value) -> Value {
    let semantic = value_field(entry, "semantic");
    let user = value_field(semantic, "user");
    let notifications = value_field(semantic, "notifications");
    let score = match user.get("attention").and_then(Value::as_str) {
        Some("error") => 5,
        Some("needs_input" | "needs_response") => 4,
        Some("blocked") => 3,
        _ if notifications
            .get("unreadCount")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            > 0 =>
        {
            2
        }
        _ if semantic
            .get("activityNewCount")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            > 0
            || user.get("label").and_then(Value::as_str) == Some("done") =>
        {
            1
        }
        _ => 0,
    };
    Value::from(score)
}

fn preferred_thread_index(participant_id: &str, entries: &[Value]) -> i64 {
    let mut scored = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| {
            array_field(value_field(entry, "thread"), "participants")
                .iter()
                .any(|participant| participant.as_str() == Some(participant_id))
        })
        .map(|(index, entry)| {
            let thread = value_field(entry, "thread");
            let waiting_on_me =
                contains_string(value_field(thread, "waitingOn"), participant_id) as i64 * 3;
            let unread =
                contains_string(value_field(thread, "unreadBy"), participant_id) as i64 * 2;
            let owns_waiting = (thread.get("owner").and_then(Value::as_str) == Some(participant_id)
                && !array_field(thread, "waitingOn").is_empty())
                as i64;
            (
                index,
                string_field(thread, "updatedAt"),
                waiting_on_me + unread + owns_waiting,
            )
        })
        .collect::<Vec<_>>();
    if scored.is_empty() {
        return -1;
    }
    scored.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| b.1.cmp(&a.1)));
    scored[0].0 as i64
}

fn describe_handoff_state(thread: &Value) -> Value {
    if thread.get("status").and_then(Value::as_str) == Some("done") {
        return Value::String(format!(
            "completed by {}",
            thread
                .get("owner")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ));
    }
    let waiting_on = array_field(thread, "waitingOn")
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if !waiting_on.is_empty() {
        return Value::String(format!(
            "{} waiting on {}",
            thread
                .get("owner")
                .or_else(|| thread.get("createdBy"))
                .and_then(Value::as_str)
                .unwrap_or_default(),
            waiting_on.join(", ")
        ));
    }
    let owner = thread.get("owner").and_then(Value::as_str);
    let created_by = thread.get("createdBy").and_then(Value::as_str);
    if let Some(owner) = owner
        && Some(owner) != created_by
    {
        return Value::String(format!("accepted by {owner}"));
    }
    let recipients = array_field(thread, "participants")
        .iter()
        .filter_map(Value::as_str)
        .filter(|participant| Some(*participant) != created_by)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    Value::String(format!(
        "awaiting acceptance from {}",
        if recipients.is_empty() {
            "recipient".into()
        } else {
            recipients.join(", ")
        }
    ))
}

struct RuntimeCoreTargetState {
    scenario: Value,
    targets: BTreeMap<String, Value>,
    resolved_targets: BTreeMap<String, Value>,
    metadata_by_window: BTreeMap<String, Value>,
    calls: Vec<Value>,
}

impl RuntimeCoreTargetState {
    fn new(scenario: &Value) -> Self {
        Self {
            scenario: scenario.clone(),
            targets: value_map_from_pairs(value_field(scenario, "sessionTmuxTargets")),
            resolved_targets: value_map_from_pairs(value_field(scenario, "resolvedTargets")),
            metadata_by_window: value_map_from_pairs(value_field(scenario, "metadataByWindow")),
            calls: Vec::new(),
        }
    }

    fn resolve_live_session_tmux_target(
        &mut self,
        session_id: &str,
        fallback: Option<&Value>,
    ) -> Option<Value> {
        let candidate = self
            .targets
            .get(session_id)
            .cloned()
            .or_else(|| fallback.filter(|value| !value.is_null()).cloned());
        if let Some(candidate) = candidate {
            let session_name = string_field(&candidate, "sessionName");
            let window_id = string_field(&candidate, "windowId");
            self.call(
                "getTargetByWindowId",
                vec![
                    Value::String(session_name),
                    Value::String(window_id.clone()),
                ],
            );
            if let Some(resolved) = self.resolved_targets.get(&window_id).cloned() {
                if resolved.is_null() {
                    self.targets.remove(session_id);
                } else {
                    self.call("getWindowMetadata", vec![resolved.clone()]);
                    let metadata = self
                        .metadata_by_window
                        .get(&string_field(&resolved, "windowId"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    if metadata.get("kind").and_then(Value::as_str) == Some("agent")
                        && metadata.get("sessionId").and_then(Value::as_str) == Some(session_id)
                    {
                        self.targets.insert(session_id.to_owned(), resolved.clone());
                        return Some(resolved);
                    }
                    if metadata.is_null() && self.can_accept_metadataless_target(session_id) {
                        self.targets.insert(session_id.to_owned(), resolved.clone());
                        return Some(resolved);
                    }
                    self.targets.remove(session_id);
                }
            } else {
                self.targets.remove(session_id);
            }
        }

        let project_root = self
            .scenario
            .get("projectRoot")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("<REPO>")
            .to_owned();
        self.call(
            "listProjectManagedWindows",
            vec![Value::String(project_root)],
        );
        for row in array_field(&self.scenario, "projectWindows") {
            let metadata = value_field(&row, "metadata");
            if metadata.get("kind").and_then(Value::as_str) != Some("agent")
                || metadata.get("sessionId").and_then(Value::as_str) != Some(session_id)
            {
                continue;
            }
            let target = value_field(&row, "target").clone();
            self.call("isWindowAlive", vec![target.clone()]);
            if target.get("alive").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            self.targets.insert(session_id.to_owned(), target.clone());
            return Some(target);
        }
        None
    }

    fn can_accept_metadataless_target(&self, session_id: &str) -> bool {
        array_field(&self.scenario, "sessions")
            .iter()
            .any(|session| {
                string_field(session, "id") == session_id
                    && session
                        .get("startTime")
                        .and_then(Value::as_i64)
                        .is_some_and(|start| {
                            FIXED_NOW_MS - start <= TARGET_METADATA_STARTUP_GRACE_MS
                        })
            })
    }

    fn targets_json(&self) -> Value {
        Value::Object(self.targets.clone().into_iter().collect())
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(call(method, args));
    }
}

fn turn_patterns_for_session(scenario: &Value, session_id: &str) -> Option<Vec<String>> {
    let key = value_map_from_pairs(value_field(scenario, "sessionToolKeys"))
        .remove(session_id)?
        .as_str()?
        .to_owned();
    match key.as_str() {
        "claude" => Some(vec![
            "/^[❯>]\\s*(.+)/".into(),
            "/^❯\\s+(.+)/".into(),
            "/^>\\s+(.+)/".into(),
        ]),
        "codex" => Some(vec!["/^[>❯]\\s*(.+)/".into()]),
        _ => None,
    }
}

fn fresh_relaunch_allowed(
    command: &str,
    backend_session_id: Option<&str>,
    quick_unexpected_exit: bool,
) -> bool {
    !(command == "claude" && backend_session_id.is_some() && quick_unexpected_exit)
}

fn iso_from_ms(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let nanos = (millis * 1_000_000) as i32;
    (OffsetDateTime::UNIX_EPOCH + Duration::seconds(seconds) + Duration::nanoseconds(nanos.into()))
        .format(&Rfc3339)
        .unwrap_or_default()
        .replace('Z', ".000Z")
}

fn push_key_value(lines: &mut Vec<String>, key: &str, value: String, width: usize) {
    lines.extend(wrap_key_value(key, &value, width));
}

fn call(method: &str, args: Vec<Value>) -> Value {
    json!({ "method": method, "args": args })
}

fn map_from_pairs(value: &Value) -> BTreeMap<String, String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|pair| {
            let pair = pair.as_array()?;
            Some((
                pair.first()?.as_str()?.to_owned(),
                pair.get(1)?.as_str()?.to_owned(),
            ))
        })
        .collect()
}

fn value_map_from_pairs(value: &Value) -> BTreeMap<String, Value> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|pair| {
            let pair = pair.as_array()?;
            Some((pair.first()?.as_str()?.to_owned(), pair.get(1)?.clone()))
        })
        .collect()
}

fn map_value(value: &Value, key: &str, entry_key: &str) -> Option<Value> {
    value_map_from_pairs(value_field(value, key)).remove(entry_key)
}

fn transport_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn string_set_from_array(value: &Value) -> BTreeSet<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn insert_optional_string(
    map: &mut serde_json::Map<String, Value>,
    key: &str,
    value: Option<String>,
) {
    if let Some(value) = value {
        map.insert(key.into(), Value::String(value));
    }
}

fn insert_optional_value(
    map: &mut serde_json::Map<String, Value>,
    key: &str,
    value: Option<Value>,
) {
    if let Some(value) = value
        && !value.is_null()
    {
        map.insert(key.into(), value);
    }
}

fn worktree_pairs(input: &Value) -> BTreeMap<String, String> {
    map_from_pairs(value_field(input, "worktreePairs"))
}

fn is_project_control_session(session: &Value) -> bool {
    value_field(session, "team")
        .get("projectControl")
        .and_then(Value::as_bool)
        == Some(true)
}

fn string_or(value: &Value, preferred: &str, fallback: &str) -> String {
    value
        .get(preferred)
        .and_then(Value::as_str)
        .or_else(|| value.get(fallback).and_then(Value::as_str))
        .unwrap_or_default()
        .to_owned()
}

fn string_or_literal(value: &Value, preferred: &str, fallback: &str) -> String {
    value
        .get(preferred)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_owned()
}

fn has_string(value: &Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
}

fn basename_for_host(value: &str) -> String {
    Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(value)
        .to_owned()
}

fn sensitive_option_arg(arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    let lower = lower.trim_start_matches('-');
    [
        "token",
        "secret",
        "password",
        "pass",
        "key",
        "credential",
        "auth",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn sensitive_env_arg(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASS",
        "KEY",
        "CREDENTIAL",
        "AUTH",
    ]
    .iter()
    .any(|needle| upper.contains(needle))
}

fn codex_option_with_value(arg: &str) -> bool {
    matches!(
        arg,
        "-a" | "--add-dir"
            | "--ask-for-approval"
            | "-c"
            | "--cd"
            | "--config"
            | "-i"
            | "--image"
            | "--local-provider"
            | "-m"
            | "--model"
            | "-p"
            | "--profile"
            | "--remote"
            | "--remote-auth-token-env"
            | "-s"
            | "--sandbox"
    )
}

fn contains_string(value: &Value, needle: &str) -> bool {
    value
        .as_array()
        .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(needle)))
}

fn hex_sha256(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn value_field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
