use aimux::core_cli::{
    CoreCliAction, CoreCliContext, CoreLoopActorContext, classify_core_cli_with_project_resolver,
};
use aimux::core_cli_routing::{CoreLogsSubcommand, parse_core_logs_args};
use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::core_text::render_core_work_outline_entries_lines;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::text::metadata::{
    DaemonMetadataTextRuntime, MetadataCliResult, parse_runtime_metadata_cli_args,
    route_metadata_text_request,
};
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::daemon::text::project_content::{
    DaemonProjectContentTextRuntime, route_project_content_text_request,
};
use aimux::daemon::text::system::{
    DaemonSystemTextRuntime, OpenFocusRequest, route_system_text_request,
};
use aimux::daemon_state::MetadataApiEndpoint;
use serde::Deserialize;
use serde_json::Map;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::path::{Path, PathBuf};

const METADATA: &str = include_str!("../../../../testdata/contracts/v1/cli/metadata-command.json");
const LOGS: &str = include_str!("../../../../testdata/contracts/v1/cli/logs-command.json");
const WORK_OUTLINE: &str =
    include_str!("../../../../testdata/contracts/v1/cli/work-outline-command.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    source: String,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    source: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn metadata_cli_command_contract_is_captured() {
    assert_fixture(METADATA, "src/cli/metadata.test.ts", 4, run_metadata_case);
}

#[test]
fn logs_cli_command_contract_is_captured() {
    assert_fixture(LOGS, "src/cli/logs.test.ts", 4, run_logs_case);
}

#[test]
fn work_outline_cli_command_contract_is_captured() {
    assert_fixture(
        WORK_OUTLINE,
        "src/cli/work-outline.test.ts",
        4,
        run_work_outline_case,
    );
}

fn assert_fixture(fixture: &str, source: &str, expected_count: usize, run: fn(&Value) -> Value) {
    let contract: Contract = serde_json::from_str(fixture).expect("cli wrapper fixture parses");
    assert_eq!(contract.source, source);
    assert_eq!(contract.cases.len(), expected_count);
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, contract.source);
        assert!(!case.api.is_empty());
        let actual = run(&json!({ "api": case.api, "input": case.input }));
        assert_eq!(actual, case.output, "{} ({})", case.id, case.api);
    }
}

fn run_metadata_case(input: &Value) -> Value {
    match input.get("api").and_then(Value::as_str) {
        Some("serviceMetadataFromUrls") => {
            let urls = string_array(input.pointer("/input/urls"));
            let mut args = vec![
                "metadata".to_owned(),
                "set-services".to_owned(),
                "session".to_owned(),
                "--url".to_owned(),
            ];
            args.extend(urls);
            if let Some(label) = input.pointer("/input/label").and_then(Value::as_str) {
                args.push("--label".to_owned());
                args.push(label.to_owned());
            }
            match parse_runtime_metadata_cli_args(&args) {
                MetadataCliResult::Post { body, .. } => body["services"].clone(),
                other => json!({ "error": format!("unexpected metadata parse result: {other:?}") }),
            }
        }
        Some("registerMetadataCommand") => {
            let args = string_array(input.pointer("/input/args"));
            let calls = RefCell::new(json!({
                "getProjectServiceEndpoint": [],
                "postProjectServiceJson": [],
            }));
            let mut runtime = FixtureMetadataRuntime { calls: &calls };
            let response = route_metadata_text_request(
                &mut runtime,
                "POST",
                &format!(
                    "{}?project=.&{}",
                    CORE_API_ROUTES.metadata_text,
                    repeated_args_query(&args)
                ),
            )
            .expect("metadata text route");
            let text = text_body(response.clone());
            let success = response.status < 400;
            wrapper_output(
                Value::Null,
                if success {
                    output_lines(&text)
                } else {
                    Vec::new()
                },
                if success {
                    Vec::new()
                } else {
                    output_lines(&text)
                },
                if success { Value::Null } else { json!(1) },
                calls.into_inner(),
            )
        }
        api => json!({ "error": format!("unsupported metadata command api {api:?}") }),
    }
}

struct FixtureMetadataRuntime<'a> {
    calls: &'a RefCell<Value>,
}

impl DaemonMetadataTextRuntime for FixtureMetadataRuntime<'_> {
    fn resolve_project_root(&self, value: &str) -> String {
        if value == "." {
            "/repo".into()
        } else {
            value.into()
        }
    }

    fn ensure_project(&mut self, _project_root: &str) -> Result<(), String> {
        Ok(())
    }

    fn metadata_endpoint(&self, _project_root: &str) -> Option<MetadataApiEndpoint> {
        push_call(self.calls, "getProjectServiceEndpoint", json!([]));
        Some(MetadataApiEndpoint {
            host: "127.0.0.1".into(),
            port: 4321,
            pid: 100,
            updated_at: "now".into(),
        })
    }

    fn post_project_service_json(
        &mut self,
        _project_root: &str,
        route_path: &str,
        body: Value,
    ) -> ProjectServiceJsonResult {
        push_call(
            self.calls,
            "postProjectServiceJson",
            json!([route_path, body]),
        );
        ProjectServiceJsonResult::ok("/repo", json!({ "ok": true }))
    }
}

fn run_logs_case(input: &Value) -> Value {
    let args = string_array(input.pointer("/input/args"));
    let parsed = parse_core_logs_args(&args).expect("logs fixture command parses");
    let calls = RefCell::new(json!({
        "selectedLogPath": [],
        "parseLineCount": [],
        "readLastLogLines": [],
        "clearLogFile": [],
        "exit": [],
    }));
    let selected_path = if parsed.daemon {
        "/logs/daemon"
    } else if parsed.subcommand == CoreLogsSubcommand::Tail {
        "/logs/missing"
    } else {
        "/logs/project"
    };
    push_call(
        &calls,
        "selectedLogPath",
        json!([logs_options_value(&parsed)]),
    );
    if parsed.subcommand == CoreLogsSubcommand::Tail {
        push_call(
            &calls,
            "parseLineCount",
            json!([parsed.lines.as_deref().unwrap_or("80")]),
        );
    }
    let mut runtime = FixtureLogsRuntime {
        calls: &calls,
        selected_path: PathBuf::from(selected_path),
        log_output: if selected_path == "/logs/missing" {
            String::new()
        } else {
            "line one\nline two".into()
        },
    };
    let response = route_system_text_request(
        &mut runtime,
        match parsed.subcommand {
            CoreLogsSubcommand::Clear => "POST",
            _ => "GET",
        },
        &logs_route_path(&parsed),
        None,
    )
    .expect("logs text route");
    let text = text_body(response.clone());
    let success = response.status < 400;
    if !success {
        push_call(&calls, "exit", json!([1]));
    }
    wrapper_output(
        json!({
            "threw": !success,
            "message": if success { Value::Null } else { json!("exit") },
        })
        .as_object()
        .map(|object| {
            let mut object = object.clone();
            if success {
                object.remove("message");
            }
            Value::Object(object)
        })
        .unwrap(),
        if success {
            output_lines(&text)
        } else {
            Vec::new()
        },
        if success {
            Vec::new()
        } else {
            output_lines(&text)
        },
        Value::Null,
        calls.into_inner(),
    )
}

struct FixtureLogsRuntime<'a> {
    calls: &'a RefCell<Value>,
    selected_path: PathBuf,
    log_output: String,
}

impl DaemonSystemTextRuntime for FixtureLogsRuntime<'_> {
    fn selected_log_path(
        &mut self,
        _daemon: bool,
        _project: Option<&str>,
    ) -> Result<PathBuf, String> {
        Ok(self.selected_path.clone())
    }

    fn read_last_log_lines(&self, path: &Path, lines: usize) -> Result<String, String> {
        push_call(
            self.calls,
            "readLastLogLines",
            json!([path.to_string_lossy().to_string(), lines]),
        );
        Ok(self.log_output.clone())
    }

    fn clear_log_file(&mut self, path: &Path) -> Result<(), String> {
        push_call(
            self.calls,
            "clearLogFile",
            json!([path.to_string_lossy().to_string()]),
        );
        Ok(())
    }

    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }

    fn ensure_project(&mut self, _project_root: &str) -> Result<Value, String> {
        unreachable!("logs fixture does not exercise project service routes")
    }

    fn stop_project(&mut self, _project_root: &str, _force: bool) -> Result<Value, String> {
        unreachable!("logs fixture does not exercise project service routes")
    }

    fn remove_project(&mut self, _project_root: &str, _force: bool) -> Result<Value, String> {
        unreachable!("logs fixture does not exercise project service routes")
    }

    fn restart_project_service(
        &mut self,
        _project_root: &str,
        _serve_only: bool,
        _open_focus: Option<OpenFocusRequest>,
    ) -> Result<Value, String> {
        unreachable!("logs fixture does not exercise project service routes")
    }
}

fn run_work_outline_case(input: &Value) -> Value {
    match input.get("api").and_then(Value::as_str) {
        Some("renderWorkOutlineEntries") => json!({
            "entries": render_core_work_outline_entries_lines(input.pointer("/input/entries").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])),
            "empty": render_core_work_outline_entries_lines(input.pointer("/input/empty").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])),
        }),
        Some("registerWorkOutlineCommand") => run_work_outline_command_case(input),
        api => json!({ "error": format!("unsupported work outline command api {api:?}") }),
    }
}

fn run_work_outline_command_case(input: &Value) -> Value {
    let args = string_array(input.pointer("/input/args"));
    let calls = RefCell::new(json!({
        "prepareProjectContext": [],
        "getProjectServiceJson": [],
        "postProjectServiceJson": [],
    }));
    push_call(
        &calls,
        "prepareProjectContext",
        json!([option_value(&args, "--project")
            .map(Value::String)
            .unwrap_or(Value::Null)]),
    );
    let context = CoreCliContext {
        current_working_dir: "/repo".into(),
        current_project_root: "/repo".into(),
        daemon_running: true,
        has_credentials: false,
        loop_actor: CoreLoopActorContext::default(),
    };
    let plan = classify_core_cli_with_project_resolver(&args, &context, |_| "/repo".to_owned())
        .expect("outline command classifies");
    let CoreCliAction::TextRoute { path, body } = plan.action else {
        panic!("outline command should route through daemon text");
    };
    let mut runtime = FixtureProjectContentRuntime { calls: &calls };
    let method = if args.get(1).map(String::as_str) == Some("update") {
        "POST"
    } else {
        "GET"
    };
    let response = route_project_content_text_request(&mut runtime, method, &path, body.as_ref())
        .expect("outline text route");
    wrapper_output(
        Value::Null,
        console_log_lines(&text_body(response)),
        Vec::new(),
        Value::Null,
        calls.into_inner(),
    )
}

struct FixtureProjectContentRuntime<'a> {
    calls: &'a RefCell<Value>,
}

impl DaemonProjectContentTextRuntime for FixtureProjectContentRuntime<'_> {
    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        push_call(
            self.calls,
            "getProjectServiceJson",
            json!([route_path, { "projectRoot": project }]),
        );
        if route_path.contains("entryId=") {
            ProjectServiceJsonResult::ok("/repo", json!({ "entry": contract_outline_entry() }))
        } else {
            ProjectServiceJsonResult::ok("/repo", json!({ "entries": [contract_outline_entry()] }))
        }
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        _timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        push_call(
            self.calls,
            "postProjectServiceJson",
            json!([route_path, body, { "projectRoot": project }]),
        );
        ProjectServiceJsonResult::ok("/repo", json!({ "entry": contract_outline_entry() }))
    }
}

fn wrapper_output(
    result: Value,
    logs: Vec<Value>,
    errors: Vec<Value>,
    exit_code: Value,
    calls: Value,
) -> Value {
    json!({
        "result": result,
        "logs": logs,
        "errors": errors,
        "exitCode": exit_code,
        "calls": calls,
    })
}

fn push_call(calls: &RefCell<Value>, key: &str, value: Value) {
    if let Some(values) = calls
        .borrow_mut()
        .get_mut(key)
        .and_then(Value::as_array_mut)
    {
        values.push(value);
    }
}

fn output_lines(text: &str) -> Vec<Value> {
    let trimmed = text.trim_end_matches('\n');
    if trimmed.is_empty() {
        Vec::new()
    } else {
        vec![json!([trimmed])]
    }
}

fn console_log_lines(text: &str) -> Vec<Value> {
    text.trim_end_matches('\n')
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(|line| json!([line]))
        .collect()
}

fn text_body(response: DaemonRouteResponse) -> String {
    match response.body {
        DaemonResponseBody::Text(value) => value,
        other => panic!("expected text body, got {other:?}"),
    }
}

fn repeated_args_query(args: &[String]) -> String {
    args.iter()
        .map(|arg| format!("arg={}", encode_query_component(arg)))
        .collect::<Vec<_>>()
        .join("&")
}

fn logs_route_path(args: &aimux::core_cli_routing::CoreLogsArgs) -> String {
    let base = match args.subcommand {
        CoreLogsSubcommand::Path => CORE_API_ROUTES.logs_path_text,
        CoreLogsSubcommand::Tail => CORE_API_ROUTES.logs_tail_text,
        CoreLogsSubcommand::Clear => CORE_API_ROUTES.logs_clear_text,
    };
    let mut params = Vec::new();
    if args.daemon {
        params.push("daemon=1".to_owned());
    }
    if let Some(project) = args.project.as_deref() {
        params.push(format!("project={}", encode_query_component(project)));
    }
    if args.subcommand == CoreLogsSubcommand::Tail
        && let Some(lines) = args.lines.as_deref()
    {
        params.push(format!("lines={}", encode_query_component(lines)));
    }
    if params.is_empty() {
        base.to_owned()
    } else {
        format!("{base}?{}", params.join("&"))
    }
}

fn logs_options_value(args: &aimux::core_cli_routing::CoreLogsArgs) -> Value {
    let mut options = Map::new();
    if args.subcommand == CoreLogsSubcommand::Tail {
        options.insert(
            "lines".into(),
            Value::String(args.lines.clone().unwrap_or_else(|| "80".into())),
        );
    }
    if args.daemon {
        options.insert("daemon".into(), Value::Bool(true));
    }
    if let Some(project) = args.project.clone() {
        options.insert("project".into(), Value::String(project));
    }
    Value::Object(options)
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn option_value(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find_map(|pair| (pair[0] == flag).then(|| pair[1].clone()))
}

fn contract_outline_entry() -> Value {
    json!({
        "entryId": "outline-1",
        "topicKey": "release",
        "title": "Release",
        "summary": "Cut the release.",
        "status": "active",
        "source": "scribe",
        "sessionIds": ["codex-a"],
        "worktreePath": "/repo/main",
        "createdAt": "2026-08-30T00:00:00.000Z",
        "updatedAt": "2026-08-30T00:00:00.000Z",
        "lastSeenAt": "2026-08-30T00:00:00.000Z",
    })
}

fn encode_query_component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char)
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}
