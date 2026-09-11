//! Drives the PRODUCTION loop watcher against the recovered Node corpus.
//!
//! This used to `#[path]`-include a self-contained twin, so a green run proved
//! only that the twin matched Node — never that the shipped code did. Only the
//! JSON-to-arguments marshalling lives here now; every behavioural function
//! below is the one the project service calls.

use aimux::loop_watcher::{
    LoopSend, LoopWatcher, build_overseer_briefing, find_loop_candidates_with_overseer,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

const FIXTURE: &str =
    include_str!("../../../../../testdata/contracts/v1/coordination/loop-watcher.json");

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

fn send_json(send: &LoopSend) -> Value {
    json!({ "sessionId": send.session_id, "text": send.text })
}

fn run_case(input: &Value) -> Value {
    match input.get("api").and_then(Value::as_str).unwrap_or_default() {
        "findLoopCandidates" => json!(find_loop_candidates_with_overseer(
            input,
            input.get("overseerId").and_then(Value::as_str)
        )),
        "buildOverseerBriefing" => {
            let candidates = input
                .get("candidates")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let template = input.get("template").and_then(Value::as_str);
            json!(build_overseer_briefing(candidates, template))
        }
        "LoopWatcher.scan" => run_scan(input),
        api => panic!("unknown loop watcher contract api: {api}"),
    }
}

fn run_scan(input: &Value) -> Value {
    let mut now = input
        .get("now")
        .and_then(Value::as_i64)
        .unwrap_or(1_000_000);
    let failures = input
        .get("sendFailures")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect::<BTreeSet<_>>();

    let mut watcher = LoopWatcher::new();
    let mut sends = Vec::<Value>::new();
    let mut outputs = Vec::<Value>::new();

    let scan_once = |watcher: &mut LoopWatcher, now: i64, sends: &mut Vec<Value>| {
        let mut deliver = |send: &LoopSend| !failures.contains(&send.session_id);
        for send in watcher.scan(input, now, &mut deliver) {
            sends.push(send_json(&send));
        }
    };

    match input.get("ops").and_then(Value::as_array) {
        Some(ops) => {
            for op in ops {
                match op.get("kind").and_then(Value::as_str).unwrap_or_default() {
                    "advance" => {
                        now += op.get("ms").and_then(Value::as_i64).unwrap_or(0);
                        outputs.push(json!({ "kind": "advance", "now": now }));
                    }
                    "scan" => {
                        scan_once(&mut watcher, now, &mut sends);
                        outputs.push(json!({ "kind": "scan", "sends": sends }));
                    }
                    kind => panic!("unknown loop watcher op: {kind}"),
                }
            }
        }
        None => {
            scan_once(&mut watcher, now, &mut sends);
            outputs.push(json!({ "kind": "scan", "sends": sends }));
        }
    }

    json!(outputs)
}

#[test]
fn loop_watcher_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("loop watcher fixture parses");
    assert_eq!(contract.cases.len(), 15);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
