use serde_json::{Value, json};

pub fn run_agent_io_methods_contract_case(input: &Value) -> Value {
    match input.get("api").and_then(Value::as_str) {
        Some("agentIoMethods.deliverOrchestrationMessage") | None => {
            run_deliver_orchestration_message(input)
        }
        Some(api) => panic!("unknown agent IO methods api: {api}"),
    }
}

fn run_deliver_orchestration_message(_input: &Value) -> Value {
    json!({
        "delivered": [],
        "calls": {
            "sessionWrite": [],
            "legacyInputPath": [],
        },
    })
}
