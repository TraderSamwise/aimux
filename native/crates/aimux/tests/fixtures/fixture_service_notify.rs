use aimux::local_ui_server::{LocalUiConfig, LocalUiServerOptions, start_local_ui_server};
use serde::Deserialize;
use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

const LOCAL_UI: &str =
    include_str!("../../../../../testdata/contracts/v1/service/local-ui-server.json");

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
fn local_ui_server_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(LOCAL_UI).expect("local ui fixture parses");
    assert_eq!(contract.cases.len(), 6);
    assert_contract(contract, run_local_ui_server_case, "local ui server");
}

fn assert_contract(contract: Contract, run: fn(&Value) -> Value, label: &str) {
    let mut failures = Vec::new();
    for case in contract.cases {
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
        "{label} parity failures:\n{}",
        failures.join("\n\n")
    );
}

fn run_local_ui_server_case(input: &Value) -> Value {
    let root = temp_root("local-ui-contract");
    fs::create_dir_all(root.join("assets")).expect("create assets");
    fs::write(root.join("index.html"), "<main>Aimux UI</main>").expect("write index");
    fs::write(root.join("assets").join("app.js"), "console.log('aimux');").expect("write js");

    let host = input
        .get("host")
        .and_then(Value::as_str)
        .unwrap_or("127.0.0.1");
    let server = match start_local_ui_server(LocalUiServerOptions {
        host: host.to_owned(),
        port: 0,
        ui_root: root.clone(),
        config: LocalUiConfig {
            connection_mode: "local".into(),
            daemon_url: "http://127.0.0.1:43190".into(),
        },
    }) {
        Ok(server) => server,
        Err(error) => {
            cleanup(root);
            return serde_json::json!({
                "rejected": true,
                "message": error.to_string(),
            });
        }
    };

    let path = input.get("path").and_then(Value::as_str).unwrap_or("/");
    let response = request(server.port, path);
    let _ = server.close();
    cleanup(root);
    summarize_response(&response)
}

fn request(port: u16, path: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect local ui server");
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: local.aimux\r\nConnection: close\r\n\r\n"
    )
    .expect("write request");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("read response");
    response
}

fn summarize_response(response: &str) -> Value {
    let (head, body) = response.split_once("\r\n\r\n").unwrap_or((response, ""));
    let mut lines = head.lines();
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .expect("status code");
    if status != 200 {
        return serde_json::json!({ "status": status });
    }
    serde_json::json!({
        "status": status,
        "contentType": header_value(head, "Content-Type").expect("content type"),
        "cacheControl": header_value(head, "Cache-Control").expect("cache control"),
        "bodyContainsAimuxUi": body.contains("Aimux UI"),
        "bodyContainsDaemonUrl": body.contains("http://127.0.0.1:43190"),
        "bodyContainsConsoleLog": body.contains("console.log"),
    })
}

fn header_value<'a>(headers: &'a str, name: &str) -> Option<&'a str> {
    headers.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

fn temp_root(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-service-notify-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    fs::create_dir_all(&path).expect("create temp root");
    path
}

fn cleanup(path: PathBuf) {
    let _ = fs::remove_dir_all(path);
}
