use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/source-boundary/inventory.json");

#[derive(Debug, Deserialize)]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn source_boundary_inventory_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("source boundary fixture parses");
    assert_eq!(contract.cases.len(), 29);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_case(&case.input);
        let expected = normalize_expected_for_deleted_sources(case.output);
        if actual != expected {
            failures.push(json!({
                "id": case.id,
                "name": case.name,
                "expected": expected,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} source-boundary parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(input: &Value) -> Value {
    match input["api"].as_str().unwrap_or_default() {
        "forbiddenSubstrings" => forbidden_substrings(input),
        "substringPolicy" => substring_policy(input),
        "daemonSupervisorImportInventory" => daemon_supervisor_import_inventory(input),
        "multiplexerCoreCommandClientImports" => multiplexer_core_command_client_imports(),
        "multiplexerChildProcessImports" => multiplexer_child_process_imports(input),
        "legacyExchangePathInventory" => legacy_exchange_path_inventory(input),
        "planAuthorityPathInventory" => plan_authority_path_inventory(input),
        "tuiApiBoundaryInventory" => tui_api_boundary_inventory(input),
        "stdoutDimensions" => stdout_dimensions(input),
        "packageEntrypoints" => package_entrypoints(),
        "localNodeToolInventory" => local_node_tool_inventory(),
        "retiredCliBootstrapInventory" => retired_cli_bootstrap_inventory(input),
        "runtimeNodeLaunchInventory" => runtime_node_launch_inventory(),
        "childProcessImportInventory" => child_process_import_inventory(input),
        "nodeDashHeredocProbes" => node_dash_heredoc_probes(input),
        "childProcessNodeCommandProbes" => child_process_node_command_probes(input),
        "retiredMainEntrypointInventory" => retired_main_entrypoint_inventory(),
        "processInspectionInventory" => process_inspection_inventory(),
        api => panic!("unknown source-boundary api: {api}"),
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repo root resolves")
}

fn read_source(path: &str) -> String {
    read_source_optional(path).unwrap_or_default()
}

fn read_source_optional(path: &str) -> Option<String> {
    let bytes = fs::read(repo_root().join(path)).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn source_file_exists(path: &str) -> bool {
    repo_root().join(path).exists()
}

fn list_files(root: &str, ts_only: bool, skip_tests: bool) -> Vec<String> {
    let mut out = Vec::new();
    visit_files(&repo_root().join(root), ts_only, skip_tests, &mut out);
    out.sort();
    out
}

fn visit_files(path: &Path, ts_only: bool, skip_tests: bool, out: &mut Vec<String>) {
    let rel = path
        .strip_prefix(repo_root())
        .expect("path under repo")
        .to_string_lossy()
        .replace('\\', "/");
    let Ok(meta) = fs::metadata(path) else {
        return;
    };
    if meta.is_dir() {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if matches!(
            name,
            ".git" | "coverage" | "dist" | "dist-ui" | "node_modules" | "release"
        ) {
            return;
        }
        let mut children = fs::read_dir(path)
            .unwrap_or_else(|err| panic!("read directory {}: {err}", path.display()))
            .collect::<Result<Vec<_>, _>>()
            .expect("directory entries read");
        children.sort_by_key(|entry| entry.path());
        for entry in children {
            visit_files(&entry.path(), ts_only, skip_tests, out);
        }
        return;
    }
    if !meta.is_file() {
        return;
    }
    if ts_only && !rel.ends_with(".ts") {
        return;
    }
    if rel.ends_with(".d.ts") {
        return;
    }
    if skip_tests && (rel.ends_with(".test.ts") || rel.ends_with(".test.mts")) {
        return;
    }
    if rel.starts_with("scripts/capture-") && rel.ends_with("-contract.mjs") {
        return;
    }
    if rel.starts_with("scripts/capture-") && rel.ends_with("-contracts.mjs") {
        return;
    }
    out.push(rel);
}

fn string_array(values: impl IntoIterator<Item = String>) -> Value {
    Value::Array(values.into_iter().map(Value::String).collect())
}

fn input_strings(input: &Value, key: &str) -> Vec<String> {
    input[key]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str().map(ToOwned::to_owned))
        .collect()
}

fn allowed_set(input: &Value) -> HashSet<String> {
    input_strings(input, "allowed").into_iter().collect()
}

fn forbidden_substrings(input: &Value) -> Value {
    let file = input["file"].as_str().expect("file input");
    let text = read_source(file);
    string_array(
        input_strings(input, "forbidden")
            .into_iter()
            .filter(|pattern| text.contains(pattern)),
    )
}

fn substring_policy(input: &Value) -> Value {
    let mut violations = Vec::new();
    for check in input["checks"].as_array().into_iter().flatten() {
        let file = check["file"].as_str().expect("check file");
        let Some(text) = read_source_optional(file) else {
            continue;
        };
        for pattern in check["forbidden"].as_array().into_iter().flatten() {
            let pattern = pattern.as_str().expect("forbidden pattern");
            if text.contains(pattern) {
                violations.push(format!("{file}:forbidden:{pattern}"));
            }
        }
        for pattern in check["required"].as_array().into_iter().flatten() {
            let pattern = pattern.as_str().expect("required pattern");
            if !text.contains(pattern) {
                violations.push(format!("{file}:missing:{pattern}"));
            }
        }
    }
    string_array(violations)
}

fn daemon_supervisor_import_inventory(input: &Value) -> Value {
    let allowed = allowed_set(input);
    let offenders = list_files("src", true, true)
        .into_iter()
        .map(|file| file.trim_start_matches("src/").to_owned())
        .filter(|file| !allowed.contains(file))
        .filter(|file| read_source(&format!("src/{file}")).contains("daemon-supervisor.js"));
    string_array(offenders)
}

fn multiplexer_core_command_client_imports() -> Value {
    string_array(
        list_files("src/multiplexer", true, true)
            .into_iter()
            .filter(|file| read_source(file).contains("core-command-client.js")),
    )
}

fn multiplexer_child_process_imports(input: &Value) -> Value {
    let allowed = allowed_set(input);
    string_array(
        list_files("src/multiplexer", true, true)
            .into_iter()
            .filter(|file| !allowed.contains(file))
            .filter(|file| has_child_process_import(&read_source(file))),
    )
}

fn legacy_exchange_path_inventory(input: &Value) -> Value {
    let allowed = allowed_set(input);
    string_array(
        ["src", "app"]
            .into_iter()
            .flat_map(|root| list_files(root, false, false))
            .filter(|file| has_legacy_exchange_path(&read_source(file)))
            .filter(|file| !allowed.contains(file)),
    )
}

fn plan_authority_path_inventory(input: &Value) -> Value {
    let allowed = allowed_set(input);
    string_array(
        ["src", "app"]
            .into_iter()
            .flat_map(|root| list_files(root, false, false))
            .filter(|file| has_plan_authority_path(&read_source(file)))
            .filter(|file| !allowed.contains(file)),
    )
}

fn tui_api_boundary_inventory(input: &Value) -> Value {
    let allowed = allowed_set(input);
    let mut violations = Vec::new();
    for root in ["src/multiplexer", "src/dashboard", "src/tui"] {
        for file in list_files(root, true, true) {
            if allowed.contains(&file) {
                continue;
            }
            let text = read_source(&file);
            for (line_index, line) in text.lines().enumerate() {
                if line.contains("host.getFromProjectService(")
                    || line.contains("host.postToProjectService(")
                {
                    violations.push(format!(
                        "{}:{} raw host project-service transport: {}",
                        file,
                        line_index + 1,
                        line.trim()
                    ));
                }
                if line.contains("this.getFromProjectService(")
                    || line.contains("this.postToProjectService(")
                {
                    violations.push(format!(
                        "{}:{} raw instance project-service transport: {}",
                        file,
                        line_index + 1,
                        line.trim()
                    ));
                }
                if line.contains("requestProjectService(") {
                    violations.push(format!(
                        "{}:{} low-level project-service request loop: {}",
                        file,
                        line_index + 1,
                        line.trim()
                    ));
                }
            }
            if text.contains("from \"")
                && text.contains("dashboard-control.js")
                && (text.contains("getFromProjectService")
                    || text.contains("postToProjectService")
                    || text.contains("requestProjectService"))
            {
                violations.push(format!(
                    "{file}:1 raw dashboard-control transport import: dashboard-control.js"
                ));
            }
        }
    }
    string_array(violations)
}

fn stdout_dimensions(input: &Value) -> Value {
    let file = input["file"].as_str().expect("file input");
    let text = read_source(file);
    json!({
        "readsStdoutDimensions": text.contains("process.stdout.columns")
            || text.contains("process.stdout.rows")
            || text.contains("process.stdout?.columns")
            || text.contains("process.stdout?.rows")
    })
}

fn package_entrypoints() -> Value {
    let package: Value =
        serde_json::from_str(&read_source("package.json")).expect("package.json parses");
    json!({
        "main": package["main"],
        "binAimux": package["bin"]["aimux"],
        "start": package["scripts"]["start"],
    })
}

fn local_node_tool_inventory() -> Value {
    let mut violations = Vec::new();
    for file in ["package.json", "app/package.json"] {
        let package: Value = serde_json::from_str(&read_source(file)).expect("package parses");
        if let Some(scripts) = package["scripts"].as_object() {
            for (name, script) in scripts {
                if script.as_str().is_some_and(is_local_node_tool_command) {
                    violations.push(format!("{file}:scripts.{name}"));
                }
            }
        }
    }
    if is_local_node_tool_command(&read_source("app/eas-release.config.json")) {
        violations.push("app/eas-release.config.json:commands".to_owned());
    }
    for file in [
        "scripts/audit-agent-output-parser.mjs",
        "app/scripts/check-release-env.js",
    ] {
        if read_source_optional(file)
            .as_deref()
            .is_some_and(is_local_node_tool_command)
        {
            violations.push(file.to_owned());
        }
    }
    json!({
        "probes": [is_local_node_tool_command("node scripts/tool.js"), is_local_node_tool_command("node ./scripts/tool.js")],
        "violations": violations,
    })
}

fn retired_cli_bootstrap_inventory(input: &Value) -> Value {
    let mut violations = Vec::new();
    for entry in input["entries"].as_array().into_iter().flatten() {
        let id = entry["id"].as_str().expect("entry id");
        let path = entry["path"].as_str().expect("entry path");
        let Some(text) = read_source_optional(path) else {
            continue;
        };
        let matches = match id {
            "bin-shim" => text
                .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .any(|word| word == "node"),
            "release-shim" => {
                text.contains("installed-aimux-shim.sh") || text.contains("AIMUX_NODE_BIN")
            }
            "installed-shim" => text.contains("dist/launcher-bin.js"),
            _ => false,
        };
        if matches {
            violations.push(id.to_owned());
        }
    }
    string_array(violations)
}

fn normalize_expected_for_deleted_sources(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .filter(|item| {
                    item.as_str()
                        .and_then(source_path_from_output_item)
                        .is_none_or(|path| source_file_exists(&path))
                })
                .collect(),
        ),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, normalize_expected_for_deleted_sources(value)))
                .collect(),
        ),
        value => value,
    }
}

fn source_path_from_output_item(item: &str) -> Option<String> {
    let candidate = item.split(':').next().unwrap_or(item);
    if candidate.starts_with("src/")
        || candidate.starts_with("app/")
        || candidate.starts_with("scripts/")
        || matches!(candidate, "package.json" | "app/package.json" | "bin/aimux")
    {
        return Some(candidate.to_owned());
    }
    if candidate.contains('/') && candidate.ends_with(".ts") {
        return Some(format!("src/{candidate}"));
    }
    None
}

fn runtime_node_launch_inventory() -> Value {
    let mut violations = Vec::new();
    let files = ["bin", "scripts", "src"]
        .into_iter()
        .flat_map(|root| list_files(root, false, true))
        .chain(["package.json".to_owned(), "app/package.json".to_owned()]);
    for file in files {
        let text = read_source(&file);
        for id in runtime_node_launch_pattern_ids(&text) {
            violations.push(format!("{file}:{id}"));
        }
        if text.contains("getAimuxCliLaunchCommand") {
            violations.push(format!("{file}:generic-cli-launch-command"));
        }
        if text.contains("process.execPath") && file != "src/cli-launcher.ts" {
            violations.push(format!("{file}:process.execPath"));
        }
        for (name, allowed) in launch_contract_usage() {
            if text.contains(name) && !allowed.contains(&file.as_str()) {
                violations.push(format!("{file}:{name}"));
            }
        }
    }
    string_array(violations)
}

fn child_process_import_inventory(input: &Value) -> Value {
    let allowed = allowed_set(input);
    string_array(
        ["bin", "scripts", "src"]
            .into_iter()
            .flat_map(|root| list_files(root, false, true))
            .filter(|file| has_child_process_import(&read_source(file)))
            .filter(|file| !allowed.contains(file)),
    )
}

fn node_dash_heredoc_probes(input: &Value) -> Value {
    Value::Array(
        input_strings(input, "probes")
            .into_iter()
            .map(|probe| Value::Bool(is_node_dash_heredoc(&probe)))
            .collect(),
    )
}

fn child_process_node_command_probes(input: &Value) -> Value {
    let probes = &input["probes"];
    json!({
        "fileCommand": probes["fileCommand"].as_array().into_iter().flatten().map(|probe| {
            let probe = probe.as_str().unwrap_or_default();
            Value::Bool(has_node_file_command(probe))
        }).collect::<Vec<_>>(),
        "shellCommand": probes["shellCommand"].as_array().into_iter().flatten().map(|probe| {
            let probe = probe.as_str().unwrap_or_default();
            Value::Bool(has_node_shell_command(probe))
        }).collect::<Vec<_>>(),
        "forkCommand": probes["forkCommand"].as_array().into_iter().flatten().map(|probe| {
            let probe = probe.as_str().unwrap_or_default();
            Value::Bool(has_fork_command(probe))
        }).collect::<Vec<_>>(),
    })
}

fn retired_main_entrypoint_inventory() -> Value {
    let allowed = [
        (
            "src/dashboard/command-spec.ts",
            "path-join",
            "join(installRoot, \"dist\", \"main.js\")",
        ),
        (
            "src/daemon.test.ts",
            "slash-path",
            "node /opt/aimux/dist/main.js",
        ),
        (
            "src/project-takeover.test.ts",
            "slash-path",
            "node /opt/aimux/dist/main.js",
        ),
        (
            "src/process-inspector.test.ts",
            "slash-path",
            "node /opt/aimux/dist/main.js",
        ),
        (
            "src/runtime-coherence.test.ts",
            "slash-path",
            "/opt/aimux/native/local-old/dist/main.js",
        ),
        (
            "src/runtime-coherence.ts",
            "slash-path",
            "\"/dist/main.js\"",
        ),
        (
            "src/runtime-restart.test.ts",
            "slash-path",
            "/old/dist/main.js",
        ),
        (
            "src/runtime-restart.test.ts",
            "slash-path",
            "node /opt/aimux/dist/main.js",
        ),
    ];
    let mut violations = Vec::new();
    for file in ["bin", "scripts", "src"]
        .into_iter()
        .flat_map(|root| list_files(root, false, false))
    {
        if file == "src/one-shot-node-inventory.test.ts" {
            continue;
        }
        for (index, line) in read_source(&file).lines().enumerate() {
            for (id, matched) in [
                ("slash-path", line.contains("dist/main.js")),
                (
                    "path-join",
                    line.contains("\"dist\", \"main.js\"")
                        || line.contains("'dist', 'main.js'")
                        || line.contains("`dist`, `main.js`"),
                ),
            ] {
                if !matched {
                    continue;
                }
                let allowed_line = allowed.iter().any(|(allowed_file, allowed_id, needle)| {
                    *allowed_file == file && *allowed_id == id && line.contains(needle)
                });
                if !allowed_line {
                    violations.push(format!("{}:{}:{id}", file, index + 1));
                }
            }
        }
    }
    string_array(violations)
}

fn process_inspection_inventory() -> Value {
    let mut violations = Vec::new();
    for file in ["bin", "scripts", "src"]
        .into_iter()
        .flat_map(|root| list_files(root, false, true))
    {
        let text = read_source(&file);
        for id in process_inspection_pattern_ids(&text) {
            if file != "src/process-inspector.ts" {
                violations.push(format!("{file}:{id}"));
            }
        }
        if text.contains("commandArgValueMatches")
            && file != "src/process-args.ts"
            && file != "src/process-inspector.ts"
        {
            violations.push(format!("{file}:commandArgValueMatches"));
        }
    }
    string_array(violations)
}

fn has_child_process_import(text: &str) -> bool {
    text.contains("from \"node:child_process\"")
        || text.contains("from 'node:child_process'")
        || text.contains("from \"child_process\"")
        || text.contains("from 'child_process'")
        || text.contains("import(\"node:child_process\")")
        || text.contains("import('node:child_process')")
        || text.contains("require(\"node:child_process\")")
        || text.contains("require('node:child_process')")
}

fn has_legacy_exchange_path(text: &str) -> bool {
    text.contains("getLegacyThreadsDir")
        || text.contains("getLegacyTasksDir")
        || text.contains(".aimux/threads")
        || text.contains(".aimux/tasks")
        || text.lines().any(|line| {
            line.contains("join(")
                && (line.contains("getLocalAimuxDir()")
                    || line.contains("localAimuxDir")
                    || line.contains("repoRoot")
                    || line.contains("\".aimux\"")
                    || line.contains("'.aimux'"))
                && (line.contains("\"threads\"")
                    || line.contains("'threads'")
                    || line.contains("\"tasks\"")
                    || line.contains("'tasks'"))
        })
}

fn has_plan_authority_path(text: &str) -> bool {
    text.contains("getPlansDir")
        || text.lines().any(|line| {
            line.contains("join(")
                && (line.contains("getLocalAimuxDir()")
                    || line.contains("localAimuxDir")
                    || line.contains("repoRoot")
                    || line.contains("\".aimux\"")
                    || line.contains("'.aimux'"))
                && (line.contains("\"plans\"") || line.contains("'plans'"))
        })
}

fn is_local_node_tool_command(text: &str) -> bool {
    text.contains("node scripts/") || text.contains("node ./scripts/")
}

fn runtime_node_launch_pattern_ids(text: &str) -> Vec<&'static str> {
    let mut ids = Vec::new();
    if text.contains("node dist/launcher-bin.js") {
        ids.push("direct-node-launcher");
    }
    if text
        .lines()
        .any(|line| !line.trim_start().starts_with('#') && line.contains("node -e"))
    {
        ids.push("node-eval");
    }
    if text
        .lines()
        .any(|line| line.trim_start().starts_with("node <<"))
    {
        ids.push("node-heredoc");
    }
    if is_node_dash_heredoc(text) {
        ids.push("node-dash-heredoc");
    }
    if has_node_file_command(text) {
        ids.push("node-child-process-file-command");
    }
    if has_node_shell_command(text) {
        ids.push("node-child-process-shell-command");
    }
    if has_fork_command(text) {
        ids.push("node-child-process-fork-command");
    }
    if text.contains("spawn(process.execPath") || text.contains("spawnSync(process.execPath") {
        ids.push("spawn-process-execpath");
    }
    if text.contains("execFile(process.execPath") || text.contains("execFileSync(process.execPath")
    {
        ids.push("exec-process-execpath");
    }
    if contains_with_window(text, "\"restart\"", "\"--project\"", 160)
        || contains_with_window(text, "'restart'", "'--project'", 160)
        || contains_with_window(text, "`restart`", "`--project`", 160)
    {
        ids.push("project-restart-cli");
    }
    if text.contains("scripts/dev-lanes")
        || text.contains("dev:aimux:")
        || text.contains("dev:daemon:")
    {
        ids.push("dev-lane");
    }
    ids
}

fn contains_with_window(text: &str, first: &str, second: &str, window: usize) -> bool {
    let mut offset = 0;
    while let Some(index) = text[offset..].find(first) {
        let start = offset + index + first.len();
        let end = (start + window).min(text.len());
        if text[start..end].contains(second) {
            return true;
        }
        offset = start;
    }
    false
}

fn has_node_file_command(text: &str) -> bool {
    ["execFile", "execFileSync", "spawn", "spawnSync"]
        .iter()
        .any(|name| {
            text.contains(&format!("{name}(\"node\"")) || text.contains(&format!("{name}('node'"))
        })
}

fn has_node_shell_command(text: &str) -> bool {
    ["exec", "execSync"].iter().any(|name| {
        text.contains(&format!("{name}(\"node")) || text.contains(&format!("{name}('node"))
    })
}

fn has_fork_command(text: &str) -> bool {
    text.contains("fork(") || text.contains(".fork(")
}

fn is_node_dash_heredoc(text: &str) -> bool {
    text.lines().any(|line| {
        let trimmed = line.trim_start();
        !trimmed.starts_with('#') && trimmed.contains("node -") && trimmed.contains("<<")
    })
}

fn launch_contract_usage() -> [(&'static str, [&'static str; 3]); 4] {
    [
        (
            "getAimuxDaemonLaunchCommand",
            [
                "src/cli-launcher.ts",
                "src/daemon-supervisor.ts",
                "src/cli-launcher.test.ts",
            ],
        ),
        (
            "getAimuxDashboardLaunchCommand",
            [
                "src/cli-launcher.ts",
                "src/dashboard/command-spec.ts",
                "src/cli-launcher.test.ts",
            ],
        ),
        (
            "getAimuxProjectServiceLaunchCommand",
            [
                "src/cli-launcher.ts",
                "src/core-project-actor.ts",
                "src/cli-launcher.test.ts",
            ],
        ),
        (
            "getAimuxCurrentCliIdentity",
            [
                "src/cli-launcher.ts",
                "src/runtime-coherence.ts",
                "src/cli-launcher.test.ts",
            ],
        ),
    ]
}

fn process_inspection_pattern_ids(text: &str) -> Vec<&'static str> {
    let mut ids = Vec::new();
    if text.contains("function isPidAlive(") || text.contains("function isPidAlive (") {
        ids.push("pid-alive-helper");
    }
    if text.contains("execFileSync(\"ps\"") || text.contains("execFileSync('ps'") {
        if text.contains("args=") {
            ids.push("ps-args");
        }
        if text.contains("stat=") {
            ids.push("ps-stat");
        }
        if text.contains("-axo") {
            ids.push("ps-table");
        }
    }
    if (text.contains("execFileSync(\"lsof\"") || text.contains("execFileSync('lsof'"))
        && text.contains("cwd")
    {
        ids.push("lsof-cwd");
    }
    ids
}
