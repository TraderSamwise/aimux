use super::support;
use aimux::project_api_contract::routes;
use aimux::project_service::agent_output::{
    AgentOutputCaptureRuntime, route_agent_output_request_with_runtime,
};
use aimux::project_service::preview_snapshots::merge_expose_preview_snapshots;
use aimux::project_service::visual_clients::{
    ProjectHotSnapshotCoordinator, VisualClientLeaseRoute,
};
use aimux::runtime_topology::{coerce_runtime_topology, runtime_topology_path};
use aimux::tmux::CapturePaneOptions;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

const OUTPUT_PREVIEWS: &str =
    include_str!("../../../../../testdata/contracts/v1/metadata-server/output-previews.json");
static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn metadata_output_previews_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(OUTPUT_PREVIEWS).expect("output previews fixture parses");
    assert_eq!(contract.cases.len(), 8);
    assert_contract_cases(
        contract.cases,
        run_metadata_output_previews_case,
        "metadata output previews",
    );
}

fn assert_contract_cases(cases: Vec<Case>, run: fn(&Value) -> Value, label: &str) {
    let mut failures = Vec::new();
    for case in cases {
        let actual = run(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} parity failures:\n{}",
        label,
        failures.join("\n\n")
    );
}

fn run_metadata_output_previews_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "mergeExposePreviewSnapshots" => {
            merge_expose_preview_snapshots(input.get("captureSnapshot"), input.get("tapSnapshot"))
                .unwrap_or(Value::Null)
        }
        "measureAgentOutputReadSequence" => measure_agent_output_read_sequence(input),
        "touchVisualClientLease" => touch_visual_client_lease_sequence(input),
        "defaultDiagnostics" => {
            ProjectHotSnapshotCoordinator::default().diagnostics_at(Path::new("/repo"), fixed_now())
        }
        api => panic!("unknown metadata output previews contract api: {api}"),
    }
}

fn measure_agent_output_read_sequence(input: &Value) -> Value {
    let project = temp_project("metadata-output-previews");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");
    write(
        runtime_topology_path(&state_dir),
        serde_yaml::to_string(&topology_fixture()).expect("topology yaml"),
    )
    .expect("write topology");
    let isolation = support::TestIsolation::new("metadata-output-previews");
    let context = isolation.project_context(&project, &state_dir);
    let mut runtime = FakeOutputRuntime {
        output: production_capture_output(input),
        calls: Vec::new(),
    };
    let mut measurements = Vec::new();
    for read in array_field(input, "reads") {
        let read_input = read.get("input").unwrap_or(&Value::Null);
        let path = output_read_path(read_input);
        let response =
            route_agent_output_request_with_runtime(&context, "GET", &path, None, &mut runtime)
                .expect("agent output route");
        let recent = context.output_metrics.snapshot()["recent"]
            .as_array()
            .and_then(|recent| recent.last())
            .cloned()
            .unwrap_or_else(|| json!({}));
        measurements.push(json!({
            "result": compact_output_result(&response.body),
            "coalesced": recent.get("coalesced").and_then(Value::as_bool).unwrap_or(false),
            "duration": "<duration-ms>",
        }));
    }
    let calls = runtime
        .calls
        .into_iter()
        .map(|(window_id, options)| {
            json!({
                "windowId": window_id,
                "startLine": options.start_line,
                "endLine": options.end_line,
                "includeEscapes": options.include_escapes,
            })
        })
        .collect::<Vec<_>>();
    cleanup(project);
    json!({
        "measurements": measurements,
        "calls": calls,
    })
}

fn touch_visual_client_lease_sequence(input: &Value) -> Value {
    let coordinator = ProjectHotSnapshotCoordinator::default();
    let mut touches = Vec::new();
    for touch in array_field(input, "touches") {
        let touch_input = touch.get("input").unwrap_or(&Value::Null);
        let url = str_field(touch, "url");
        let params = query_params(url);
        let active = coordinator.touch_route_lease_at(
            &params,
            VisualClientLeaseRoute {
                surface: str_field(touch_input, "surface"),
                requested_preview: bool_field(touch_input, "requestedPreview"),
                requested_chat_preview: bool_field(touch_input, "requestedChatPreview"),
                default_kind: touch_input.get("defaultKind").and_then(Value::as_str),
                remote_address: Some(str_field(touch, "remoteAddress")),
            },
            Path::new("/repo"),
            Path::new("/state"),
            fixed_now(),
        );
        touches.push(json!({ "active": active }));
    }
    json!({
        "touches": touches,
        "diagnostics": normalize_lease_times(coordinator.diagnostics_at(Path::new("/repo"), fixed_now())),
    })
}

#[derive(Default)]
struct FakeOutputRuntime {
    output: String,
    calls: Vec<(String, CapturePaneOptions)>,
}

impl AgentOutputCaptureRuntime for FakeOutputRuntime {
    fn capture_pane(
        &mut self,
        window_id: &str,
        options: CapturePaneOptions,
    ) -> Result<String, String> {
        self.calls.push((window_id.to_owned(), options));
        Ok(self.output.clone())
    }
}

fn output_read_path(input: &Value) -> String {
    let mut params = vec![format!("sessionId={}", str_field(input, "sessionId"))];
    if let Some(start_line) = input.get("startLine").and_then(Value::as_i64) {
        params.push(format!("startLine={start_line}"));
    }
    if let Some(mode) = input.get("mode").and_then(Value::as_str) {
        params.push(format!("mode={mode}"));
    }
    if let Some(purpose) = input.get("purpose").and_then(Value::as_str) {
        params.push(format!("purpose={purpose}"));
    }
    format!("{}?{}", routes::agents::OUTPUT, params.join("&"))
}

fn compact_output_result(body: &Value) -> Value {
    let mut result = Map::new();
    for key in ["sessionId", "output", "startLine"] {
        if let Some(value) = body.get(key) {
            result.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(result)
}

fn production_capture_output(input: &Value) -> String {
    array_field(input, "readOutputs")
        .iter()
        .filter_map(|value| value.get("output").and_then(Value::as_str))
        .find(|value| !value.is_empty())
        .or_else(|| {
            array_field(input, "readOutputs")
                .first()
                .and_then(|value| value.get("output"))
                .and_then(Value::as_str)
        })
        .unwrap_or_default()
        .to_owned()
}

fn topology_fixture() -> Value {
    coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-09-05T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-agent-1", "rigId": "rig-1", "logicalId": "agent-1", "toolConfigKey": "codex", "createdAt": "2026-09-05T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-agent-1", "nodeId": "node-agent-1", "tmuxSession": "aimux-repo", "tmuxWindowId": "@agent-1", "tmuxWindowIndex": 1, "tmuxWindowName": "agent-1", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "agent-1", "nodeId": "node-agent-1", "status": "running", "command": "codex", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .expect("topology fixture")
}

fn query_params(url: &str) -> BTreeMap<String, String> {
    let Some(query) = url
        .split_once('?')
        .map(|(_, query)| query.split('#').next().unwrap_or(query))
    else {
        return BTreeMap::new();
    };
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (key.to_owned(), value.to_owned())
        })
        .collect()
}

fn normalize_lease_times(value: Value) -> Value {
    fn visit(value: Value, seen: &mut BTreeMap<String, String>, next: &mut usize) -> Value {
        match value {
            Value::Array(values) => Value::Array(
                values
                    .into_iter()
                    .map(|value| visit(value, seen, next))
                    .collect(),
            ),
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .map(|(key, value)| {
                        if matches!(key.as_str(), "startedAt" | "updatedAt" | "expiresAt")
                            && let Some(text) = value.as_str()
                        {
                            let token = seen.entry(text.to_owned()).or_insert_with(|| {
                                let token = format!("<ts:{next}>");
                                *next += 1;
                                token
                            });
                            return (key, Value::String(token.clone()));
                        }
                        (key, visit(value, seen, next))
                    })
                    .collect(),
            ),
            other => other,
        }
    }
    visit(value, &mut BTreeMap::new(), &mut 1)
}

fn fixed_now() -> i64 {
    1_800_000_000_000
}

fn temp_project(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "aimux-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
}

fn cleanup(path: impl AsRef<Path>) {
    let _ = remove_dir_all(path);
}

fn array_field<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn str_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}
