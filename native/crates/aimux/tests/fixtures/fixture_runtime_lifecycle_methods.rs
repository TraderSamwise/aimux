use aimux::runtime_lifecycle_methods::{remove_instruction_files, write_instruction_files};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const FIXTURE: &str =
    include_str!("../../../../../testdata/contracts/v1/multiplexer/runtime-lifecycle-methods.json");
const OBSERVED_FILES: [&str; 4] = ["AGENTS.md", "CLAUDE.md", "CODEX.md", "notes.md"];
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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
fn runtime_lifecycle_methods_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("runtime lifecycle methods fixture parses");
    assert_eq!(contract.cases.len(), 8);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_runtime_lifecycle_methods_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "runtime lifecycle methods parity failures:\n{}",
        failures.join("\n\n")
    );
}

fn run_runtime_lifecycle_methods_contract_case(input: &Value) -> Value {
    let project = temp_project();
    seed_input_files(&project, input);
    let mut written = input
        .get("initialWrittenInstructionFiles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();

    for operation in input
        .get("operations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        match operation {
            "writeInstructionFiles" => {
                write_instruction_files(&project, input.get("config").unwrap_or(&Value::Null));
                written.clear();
            }
            "removeInstructionFiles" => {
                remove_instruction_files(written.iter().map(|file| project.join(file)));
                written.clear();
            }
            other => panic!("unknown runtime lifecycle operation: {other}"),
        }
    }

    let output = json!({
        "files": observed_files(&project),
        "writtenInstructionFiles": written.into_iter().collect::<Vec<_>>(),
    });
    let _ = fs::remove_dir_all(project);
    output
}

fn seed_input_files(project: &Path, input: &Value) {
    for (path, content) in input
        .get("files")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let Some(content) = content.as_str() else {
            continue;
        };
        let file_path = project.join(path);
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent).expect("mkdir contract file parent");
        }
        fs::write(file_path, content).expect("write contract file");
    }
}

fn observed_files(project: &Path) -> Value {
    let mut output = Map::new();
    for file in OBSERVED_FILES {
        let path = project.join(file);
        let value = if let Ok(content) = fs::read_to_string(path) {
            json!({ "exists": true, "content": content })
        } else {
            json!({ "exists": false })
        };
        output.insert(file.to_owned(), value);
    }
    Value::Object(output)
}

fn temp_project() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-runtime-lifecycle-methods-contract-{}-{}",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("mkdir runtime lifecycle contract project");
    path
}
