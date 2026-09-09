use aimux::daemon_projects::ProjectsRouteProject;
use aimux::proxy_project_binding::{
    ProxyTarget, parse_proxy_target, resolve_project_root_for_service_target,
};
use serde_json::{Value, json};

const PROXY_PROJECT_BINDING: &str =
    include_str!("../../../../testdata/contracts/v1/proxy/project-binding.json");

#[test]
fn fixture_proxy_project_binding_matches_typescript() {
    let contract: Value =
        serde_json::from_str(PROXY_PROJECT_BINDING).expect("valid proxy/project-binding fixture");
    let cases = contract["cases"].as_array().expect("proxy binding cases");
    assert_eq!(cases.len(), 11, "unexpected proxy binding case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = proxy_binding_actual(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} proxy/project-binding parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn proxy_binding_actual(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "parseProxyTarget" => json!(parse_proxy_target_json(
            case["input"]["pathname"].as_str().unwrap_or_default()
        )),
        "parseProxyTargetBatch" => Value::Array(
            case["input"]["pathnames"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|pathname| parse_proxy_target_json(pathname.as_str().unwrap_or_default()))
                .collect(),
        ),
        "resolveProjectRootForServiceTarget" => resolve_attempt(&case["input"]),
        "resolveProjectRootForServiceTargetBatch" => Value::Array(
            case["input"]["attempts"]
                .as_array()
                .into_iter()
                .flatten()
                .map(resolve_attempt)
                .collect(),
        ),
        api => json!({ "error": format!("unknown proxy api: {api}") }),
    }
}

fn parse_proxy_target_json(pathname: &str) -> Value {
    parse_proxy_target(pathname)
        .map(|target| {
            json!({
                "host": target.host,
                "port": target.port,
                "subPath": target.sub_path,
            })
        })
        .unwrap_or(Value::Null)
}

fn resolve_attempt(input: &Value) -> Value {
    if let Some(targets) = input.get("targets").and_then(Value::as_array) {
        let candidates = candidates_from(input.get("candidates").unwrap_or(&Value::Null));
        return Value::Array(
            targets
                .iter()
                .map(|target| {
                    resolve_project_root_for_service_target(
                        &candidates,
                        target_from(target).as_ref(),
                    )
                    .map(Value::String)
                    .unwrap_or(Value::Null)
                })
                .collect(),
        );
    }
    let candidates = candidates_from(input.get("candidates").unwrap_or(&Value::Null));
    resolve_project_root_for_service_target(&candidates, target_from(&input["target"]).as_ref())
        .map(Value::String)
        .unwrap_or(Value::Null)
}

fn candidates_from(value: &Value) -> Vec<ProjectsRouteProject> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .map(|candidate| {
            let endpoint = candidate.get("serviceEndpoint").and_then(|endpoint| {
                if endpoint.is_null() {
                    None
                } else {
                    let port = match &endpoint["port"] {
                        Value::String(value) if value == "<NaN>" => Value::Null,
                        value => value.clone(),
                    };
                    Some(json!({ "host": endpoint["host"], "port": port }))
                }
            });
            ProjectsRouteProject {
                id: candidate["path"]
                    .as_str()
                    .unwrap_or_default()
                    .replace('/', "-"),
                name: candidate["path"].as_str().unwrap_or_default().to_owned(),
                path: candidate["path"].as_str().unwrap_or_default().to_owned(),
                last_seen: None,
                dashboard_session_name: "aimux-test".to_owned(),
                service: None,
                service_alive: candidate["serviceAlive"].as_bool().unwrap_or(false),
                service_endpoint: endpoint,
                online_agent_count: None,
            }
        })
        .collect()
}

fn target_from(value: &Value) -> Option<ProxyTarget> {
    if value.is_null() {
        return None;
    }
    let host = value["host"].as_str()?.to_owned();
    let port = match &value["port"] {
        Value::Number(number) => number.as_u64()?,
        Value::String(raw) if raw == "<NaN>" => return None,
        _ => return None,
    };
    Some(ProxyTarget {
        host,
        port,
        sub_path: "/agents/output".into(),
    })
}
