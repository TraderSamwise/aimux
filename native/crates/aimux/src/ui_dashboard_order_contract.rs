use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const MAIN_CHECKOUT_ORDER_KEY: &str = "__main__";

pub fn run_dashboard_order_contract_case(input: &Value) -> Value {
    match string_field(input, "api") {
        "dashboardOrderKey" => Value::Array(
            input
                .get("paths")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|path| {
                    if let Some(path) = path.as_str() {
                        json!({ "path": path, "key": dashboard_order_key(Some(path)) })
                    } else {
                        json!({ "key": dashboard_order_key(None) })
                    }
                })
                .collect(),
        ),
        "normalizeDashboardOrder" => json!(normalize_dashboard_order(
            string_array(input, "currentIds"),
            string_array(input, "savedOrder")
        )),
        "applyDashboardOrder" => {
            let items = value_array(input, "items");
            let ordered = apply_dashboard_order(&items, string_array(input, "savedOrder"));
            json!({
                "orderedIds": ordered.iter().filter_map(|item| string_field_opt(item, "id")).collect::<Vec<_>>(),
                "originalIds": items.iter().filter_map(|item| string_field_opt(item, "id")).collect::<Vec<_>>(),
            })
        }
        "moveDashboardOrder" => {
            let items = value_array(input, "items");
            let moved = move_dashboard_order(
                &items,
                string_array(input, "savedOrder"),
                string_field(input, "selectedId"),
                string_field(input, "direction"),
            );
            json!(moved)
        }
        "orderDashboardWorktreeGroups" => order_dashboard_worktree_groups(input),
        api => panic!("unknown dashboard order api: {api}"),
    }
}

fn dashboard_order_key(path: Option<&str>) -> String {
    path.unwrap_or(MAIN_CHECKOUT_ORDER_KEY).to_owned()
}

fn normalize_dashboard_order(current_ids: Vec<String>, saved_order: Vec<String>) -> Vec<String> {
    let current = current_ids.iter().cloned().collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::new();
    for id in saved_order {
        if current.contains(&id) && seen.insert(id.clone()) {
            normalized.push(id);
        }
    }
    for id in current_ids {
        if seen.insert(id.clone()) {
            normalized.push(id);
        }
    }
    normalized
}

fn apply_dashboard_order(items: &[Value], saved_order: Vec<String>) -> Vec<Value> {
    let order = normalize_dashboard_order(
        items
            .iter()
            .filter_map(|item| string_field_opt(item, "id"))
            .collect(),
        saved_order,
    );
    let by_id = items
        .iter()
        .filter_map(|item| Some((string_field_opt(item, "id")?, item.clone())))
        .collect::<BTreeMap<_, _>>();
    order
        .into_iter()
        .filter_map(|id| by_id.get(&id).cloned())
        .collect()
}

fn move_dashboard_order(
    items: &[Value],
    saved_order: Vec<String>,
    selected_id: &str,
    direction: &str,
) -> Value {
    let mut order = normalize_dashboard_order(
        items
            .iter()
            .filter_map(|item| string_field_opt(item, "id"))
            .collect(),
        saved_order,
    );
    let Some(index) = order.iter().position(|id| id == selected_id) else {
        return json!({ "moved": false, "order": order });
    };
    let next_index = if direction == "up" {
        index.checked_sub(1)
    } else {
        Some(index + 1)
    };
    let Some(next_index) = next_index.filter(|next| *next < order.len()) else {
        return json!({ "moved": false, "order": order });
    };
    order.swap(index, next_index);
    json!({ "moved": true, "order": order })
}

fn order_dashboard_worktree_groups(input: &Value) -> Value {
    let order_state = value_field(input, "orderState");
    Value::Array(
        value_array(input, "groups")
            .into_iter()
            .map(|mut group| {
                let key = dashboard_order_key(string_field_opt(&group, "path").as_deref());
                if let Value::Object(object) = &mut group {
                    let agent_order = order_state
                        .get("agentOrderByWorktreeKey")
                        .and_then(|order| order.get(&key))
                        .and_then(Value::as_array)
                        .map(|values| string_vec(values))
                        .unwrap_or_default();
                    let service_order = order_state
                        .get("serviceOrderByWorktreeKey")
                        .and_then(|order| order.get(&key))
                        .and_then(Value::as_array)
                        .map(|values| string_vec(values))
                        .unwrap_or_default();
                    object.insert(
                        "sessions".to_owned(),
                        Value::Array(apply_dashboard_order(
                            &object
                                .get("sessions")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default(),
                            agent_order,
                        )),
                    );
                    object.insert(
                        "services".to_owned(),
                        Value::Array(apply_dashboard_order(
                            &object
                                .get("services")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default(),
                            service_order,
                        )),
                    );
                }
                group
            })
            .collect(),
    )
}

fn value_array(value: &Value, field: &str) -> Vec<Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_array(value: &Value, field: &str) -> Vec<String> {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(|values| string_vec(values))
        .unwrap_or_default()
}

fn string_vec(values: &[Value]) -> Vec<String> {
    values
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value.get(field).unwrap_or(&Value::Null)
}

fn string_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn string_field_opt(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}
