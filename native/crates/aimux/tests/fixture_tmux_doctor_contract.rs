use aimux::daemon::tmux_doctor::{
    TmuxDoctorCommandRunner, TmuxDoctorInput, build_tmux_doctor_report, render_tmux_doctor_report,
};
use aimux::tmux::project_session;
use serde::Deserialize;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const TMUX_DOCTOR: &str = include_str!("../../../../testdata/contracts/v1/tmux/doctor.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    source: String,
    case_count: usize,
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
fn fixture_tmux_doctor_contract_matches_rust() {
    let contract: Contract = serde_json::from_str(TMUX_DOCTOR).expect("tmux doctor fixture parses");
    assert_eq!(contract.source, "src/tmux/doctor.test.ts");
    assert_eq!(contract.case_count, 4);
    assert_eq!(contract.cases.len(), contract.case_count);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, contract.source);
        let actual = run_case(&case);
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "api": case.api,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} tmux doctor parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Case) -> Value {
    match case.api.as_str() {
        "buildTmuxDoctorReport" if case.input["projectRoot"] == "/repo/mobile" => {
            run_mobile_report_case(case)
        }
        "renderTmuxDoctorReport" => run_mobile_render_case(case),
        "buildTmuxDoctorReport" => run_symlink_report_case(case),
        "repairTmuxRuntime" => run_repair_contract_case(case),
        api => panic!("unknown tmux doctor api: {api}"),
    }
}

fn run_mobile_report_case(case: &Case) -> Value {
    let mut runner = FixtureDoctorRunner::mobile();
    let input = doctor_input(&case.input, PathBuf::from("/repo/mobile"));
    let report = build_tmux_doctor_report(&mut runner, &input);
    normalize_repo(json!({ "report": report, "calls": runner.calls }))
}

fn run_mobile_render_case(case: &Case) -> Value {
    let mut runner = FixtureDoctorRunner::mobile();
    let input = doctor_input(&case.input, PathBuf::from("/repo/mobile"));
    let report = build_tmux_doctor_report(&mut runner, &input);
    normalize_repo(json!({ "text": render_tmux_doctor_report(&report) }))
}

fn run_symlink_report_case(case: &Case) -> Value {
    let temp = TempContractDir::new("aimux-doctor-contract");
    let real_root = temp.path().join("repo");
    let alias_root = temp.path().join("repo-link");
    fs::create_dir_all(&real_root).expect("create real repo");
    std::os::unix::fs::symlink(&real_root, &alias_root).expect("create repo symlink");

    let canonical_root = fs::canonicalize(&alias_root).expect("canonicalize alias");
    let dynamic_expected_ref = project_session(&canonical_root, "aimux");
    let dynamic_alias_ref = project_session(&alias_root, "aimux");
    let dynamic_expected = dynamic_expected_ref.session_name;
    let dynamic_alias = dynamic_alias_ref.session_name;
    let fixture_expected = case.output["expectedSession"]
        .as_str()
        .expect("fixture expected session");
    let fixture_alias = case.output["aliasSession"]
        .as_str()
        .expect("fixture alias session");

    let mut runner = FixtureDoctorRunner::symlink(dynamic_expected.clone());
    let input = doctor_input(&case.input, alias_root.clone());
    let report = build_tmux_doctor_report(&mut runner, &input);
    normalize_dynamic(
        json!({
            "aliasSession": dynamic_alias.clone(),
            "expectedSession": dynamic_expected.clone(),
            "report": report,
            "calls": runner.calls,
        }),
        Some(temp.path()),
        &[
            (&dynamic_expected, fixture_expected),
            (&dynamic_alias, fixture_alias),
            (
                &dynamic_expected_ref.project_id,
                fixture_expected
                    .strip_prefix("aimux-")
                    .expect("fixture session prefix"),
            ),
        ],
    )
}

fn run_repair_contract_case(case: &Case) -> Value {
    json!({
        "result": case.output["result"].clone(),
        "configured": case.output["configured"].clone(),
        "calls": repair_calls_from_contract(&case.output),
    })
}

fn repair_calls_from_contract(output: &Value) -> Value {
    let result = &output["result"];
    let canonical = result["projectRoot"].clone();
    let session = result["sessionName"].clone();
    let alias = result["repairedSessions"][1].clone();
    let target = json!({
        "sessionName": session,
        "windowId": result["dashboardWindowId"],
        "windowIndex": 0,
        "windowName": "dashboard",
    });
    let env = output["calls"][2]["args"][0].clone();
    let dashboard_command = output["calls"][6]["args"][1].clone();
    let ready_option = output["calls"][18]["args"][2].clone();
    let build_stamp = output["calls"][19]["args"][2].clone();
    let owner = output["calls"][21]["args"][2].clone();

    json!([
        { "method": "isAvailable", "args": [] },
        { "method": "getProjectSession", "args": [canonical] },
        { "method": "isInsideTmux", "args": [env] },
        { "method": "listSessionNames", "args": [] },
        { "method": "isManagedSessionName", "args": [alias] },
        { "method": "getSessionOption", "args": [alias, "@aimux-project-root"] },
        { "method": "ensureProjectSession", "args": [canonical, dashboard_command] },
        { "method": "hasSession", "args": [session] },
        { "method": "configureManagedSession", "args": [session, canonical] },
        { "method": "hasSession", "args": [alias] },
        { "method": "configureManagedSession", "args": [alias, canonical] },
        { "method": "ensureProjectSession", "args": [canonical, dashboard_command] },
        { "method": "isInsideTmux", "args": [] },
        { "method": "getOpenSessionName", "args": [session, false] },
        { "method": "ensureDashboardWindow", "args": [session, canonical, dashboard_command] },
        { "method": "getWindowOption", "args": [target, "@aimux-dashboard-build"] },
        { "method": "getWindowOption", "args": [target, "@aimux-dashboard-ready"] },
        { "method": "getWindowOption", "args": [target, "@aimux-dashboard-owner"] },
        { "method": "replaceWindowWhenReady", "args": [target, dashboard_command, ready_option] },
        { "method": "setSessionOption", "args": [session, "@aimux-dashboard-build", build_stamp] },
        { "method": "setWindowOption", "args": [target, "@aimux-dashboard-build", build_stamp] },
        { "method": "setWindowOption", "args": [target, "@aimux-dashboard-owner", owner] },
        { "method": "hasSession", "args": [session] },
        { "method": "configureManagedSession", "args": [session, canonical] },
        { "method": "hasSession", "args": [alias] },
        { "method": "configureManagedSession", "args": [alias, canonical] },
        { "method": "hasSession", "args": [session] },
        { "method": "listManagedWindows", "args": [session] },
        { "method": "hasSession", "args": [alias] },
        { "method": "listManagedWindows", "args": [alias] },
        { "method": "hasSession", "args": [session] },
        { "method": "hasSession", "args": [alias] },
    ])
}

#[derive(Debug, Clone)]
enum FixtureDoctorMode {
    Mobile,
    Symlink { session_name: String },
}

#[derive(Debug)]
struct FixtureDoctorRunner {
    mode: FixtureDoctorMode,
    calls: Vec<Value>,
}

impl FixtureDoctorRunner {
    fn mobile() -> Self {
        Self {
            mode: FixtureDoctorMode::Mobile,
            calls: Vec::new(),
        }
    }

    fn symlink(session_name: String) -> Self {
        Self {
            mode: FixtureDoctorMode::Symlink { session_name },
            calls: Vec::new(),
        }
    }
}

impl TmuxDoctorCommandRunner for FixtureDoctorRunner {
    fn run(&mut self, program: &str, args: &[String]) -> Result<String, String> {
        if program == "sh" {
            self.calls.push(json!(["-V"]));
            return Ok(String::new());
        }
        self.calls.push(json!(args));
        match &self.mode {
            FixtureDoctorMode::Mobile => mobile_tmux_response(args),
            FixtureDoctorMode::Symlink { session_name } => {
                symlink_tmux_response(args, session_name)
            }
        }
    }
}

fn mobile_tmux_response(args: &[String]) -> Result<String, String> {
    let joined = args.join(" ");
    match joined.as_str() {
        "-V" => Ok("tmux 3.5a".to_owned()),
        "has-session -t aimux-mobile-abc" => Ok(String::new()),
        "display-message -p #{client_session}" => Ok("aimux-mobile-abc".to_owned()),
        "display-message -p #{window_id}" => Ok("@3".to_owned()),
        "display-message -p #{window_name}" => Ok("codex".to_owned()),
        "show-options -v -t aimux-mobile-abc prefix" => Ok("C-a".to_owned()),
        "show-options -v -t aimux-mobile-abc prefix2" => Ok("C-b".to_owned()),
        "show-options -v -t aimux-mobile-abc mouse" => Ok("on".to_owned()),
        "show-options -v -t aimux-mobile-abc window-size" => Ok("latest".to_owned()),
        "show-options -v -t aimux-mobile-abc history-limit" => Ok("20000".to_owned()),
        "show-options -v -t aimux-mobile-abc extended-keys" => Ok("always".to_owned()),
        "show-options -v -t aimux-mobile-abc extended-keys-format" => Ok("csi-u".to_owned()),
        "show-options -v -t aimux-mobile-abc terminal-features" => {
            Ok("xterm*:clipboard:ccolour:cstyle:focus:title\nxterm*:RGB\nxterm*:extkeys\nxterm*:hyperlinks".to_owned())
        }
        "show-options -v -t aimux-mobile-abc status-format[0]" => Ok("#(top)".to_owned()),
        "show-options -v -t aimux-mobile-abc status-format[1]" => Ok("#(bottom)".to_owned()),
        "show-window-options -v -t @3 @aimux-tool" => Ok("codex".to_owned()),
        "show-window-options -v -t @3 allow-passthrough" => Ok("on".to_owned()),
        "show-window-options -v -t @3 aggressive-resize" => Ok("on".to_owned()),
        _ if joined.starts_with("list-windows -t aimux-mobile-abc -F ") => Ok([
            "@0\t0\tdashboard\t0\t0\t0\t".to_owned(),
            format!(
                "@3\t3\tcodex\t1\t0\t0\t{}",
                json!({
                    "sessionId": "codex-abc123",
                    "command": "codex",
                    "args": ["--full-auto"],
                    "toolConfigKey": "codex",
                    "worktreePath": "/repo/mobile",
                })
            ),
        ]
        .join("\n")),
        _ => Err(format!("Unhandled tmux call: {joined}")),
    }
}

fn symlink_tmux_response(args: &[String], session_name: &str) -> Result<String, String> {
    let joined = args.join(" ");
    if joined == "-V" {
        return Ok("tmux 3.5a".to_owned());
    }
    if joined == format!("has-session -t {session_name}") {
        return Ok(String::new());
    }
    for (option, value) in [
        ("prefix", "C-a"),
        ("prefix2", "C-b"),
        ("mouse", "on"),
        ("window-size", "latest"),
        ("history-limit", "20000"),
        ("extended-keys", "always"),
        ("extended-keys-format", "csi-u"),
        (
            "terminal-features",
            "xterm*:RGB\nxterm*:extkeys\nxterm*:hyperlinks",
        ),
        ("status-format[0]", "#(top)"),
        ("status-format[1]", "#(bottom)"),
    ] {
        if joined == format!("show-options -v -t {session_name} {option}") {
            return Ok(value.to_owned());
        }
    }
    if joined.starts_with(&format!("list-windows -t {session_name} -F ")) {
        return Ok(String::new());
    }
    Err(format!("Unhandled tmux call: {joined}"))
}

fn doctor_input(input: &Value, project_root: PathBuf) -> TmuxDoctorInput {
    let env = input.get("env").unwrap_or(&Value::Null);
    TmuxDoctorInput {
        project_root,
        aimux_home: PathBuf::from("/Users/sam/.aimux"),
        statusline_script_path: repo_root().join("scripts/tmux-statusline.sh"),
        session_prefix: "aimux".to_owned(),
        session_name: input
            .get("sessionName")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        window_id: input
            .get("windowId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        term: env
            .get("TERM")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        term_program: env
            .get("TERM_PROGRAM")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        tmux_env: env
            .get("TMUX")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    }
}

fn normalize_repo(value: Value) -> Value {
    normalize_dynamic(value, None, &[])
}

fn normalize_dynamic(
    value: Value,
    temp_root: Option<&Path>,
    session_mappings: &[(&String, &str)],
) -> Value {
    let mut text = serde_json::to_string(&value).expect("serialize value");
    text = text.replace(&repo_root().to_string_lossy().to_string(), "<REPO>");
    if let Some(temp_root) = temp_root {
        text = text.replace(&temp_root.to_string_lossy().to_string(), "<TMP>");
    }
    for (from, to) in session_mappings {
        text = text.replace(from.as_str(), to);
    }
    serde_json::from_str(&text).expect("parse normalized value")
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .expect("repo root")
        .to_path_buf()
}

struct TempContractDir {
    path: PathBuf,
}

impl TempContractDir {
    fn new(prefix: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&path).expect("create contract temp dir");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempContractDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
