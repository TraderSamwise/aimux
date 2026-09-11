use aimux::project_service::expose_ordering::{
    ExposeOrderingOptions, ExposeSublabel, assign_worktree_tones, dashboard_worktree_order_paths,
    expose_tile_context_for_item, group_items_by_project, group_items_by_worktree,
    order_expose_items, order_expose_items_by_recent_output, short_worktree, worktree_tone_key,
};
use aimux::project_service::switchable_agents::SwitchableAgentItem;
use serde_json::{Value, json};
use std::collections::BTreeMap;

const EXPOSE_ORDERING: &str =
    include_str!("../../../../../testdata/contracts/v1/tmux/expose-ordering.json");

#[test]
fn fixture_expose_ordering_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(EXPOSE_ORDERING).expect("valid expose ordering fixture");
    let cases = contract["cases"].as_array().expect("expose ordering cases");
    assert_eq!(cases.len(), 14, "unexpected expose ordering case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = run_case(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "api": case["api"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} expose-ordering parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    let input = &case["input"];
    match case["api"].as_str().expect("api") {
        "shortWorktree" => json!({
            "values": items(input).iter().map(|item| {
                short_worktree(item, string(input, "projectRoot"))
            }).collect::<Vec<_>>()
        }),
        "worktreeToneKey" => json!({
            "values": items(input).iter().map(|item| {
                worktree_tone_key(item, string(input, "projectRoot"))
            }).collect::<Vec<_>>()
        }),
        "groupItemsByProject" => json!({
            "groups": groups(group_items_by_project(&items(input)))
        }),
        "groupItemsByWorktree" => {
            let items = items(input);
            json!({
                "groups": groups(group_items_by_worktree(
                    &items,
                    string(input, "projectRoot"),
                    &options(input),
                ))
            })
        }
        "orderExposeItems" => {
            let items = items(input);
            json!({
                "itemIds": item_ids(&order_expose_items(
                    &items,
                    string(input, "projectRoot"),
                    sublabel(string(input, "sublabel")),
                    &options(input),
                ))
            })
        }
        "orderExposeItemsByRecentOutput" => {
            let items = items(input);
            json!({
                "itemIds": item_ids(&order_expose_items_by_recent_output(&items))
            })
        }
        "dashboardWorktreeOrderPaths" => {
            let topology = json!({ "worktrees": input["worktrees"].clone() });
            json!({
                "paths": dashboard_worktree_order_paths(string(input, "projectRoot"), &topology)
            })
        }
        "assignWorktreeTones" => {
            let items = items(input);
            let tones = assign_worktree_tones(&items, string(input, "projectRoot"));
            json!({ "tones": tones })
        }
        "exposeTileContextForItem" => {
            let items = items(input);
            let tones = assign_worktree_tones(&items, string(input, "projectRoot"));
            let contexts = input["sublabels"]
                .as_array()
                .expect("sublabels")
                .iter()
                .enumerate()
                .map(|(index, sublabel_value)| {
                    expose_tile_context_for_item(
                        &items[index],
                        sublabel(sublabel_value.as_str().expect("sublabel")),
                        string(input, "projectRoot"),
                        &tones,
                    )
                })
                .collect::<Vec<_>>();
            json!({ "contexts": contexts })
        }
        unexpected => panic!("unexpected api {unexpected}"),
    }
}

fn items(input: &Value) -> Vec<SwitchableAgentItem> {
    input["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(item)
        .collect()
}

fn item(value: &Value) -> SwitchableAgentItem {
    SwitchableAgentItem {
        id: string(value, "id").to_owned(),
        target: value["target"].clone(),
        metadata: value["metadata"].clone(),
        label: string(value, "label").to_owned(),
        urgency: value["urgency"].as_i64().unwrap_or_default(),
        activity: value["activity"].as_i64().unwrap_or_default(),
        last_used_at: value
            .get("lastUsedAt")
            .and_then(Value::as_str)
            .map(str::to_owned),
        recent_rank: value["recentRank"]
            .as_i64()
            .unwrap_or(9_007_199_254_740_991),
        overseer: value["overseer"].as_bool().unwrap_or_default(),
        scribe: value["scribe"].as_bool().unwrap_or_default(),
        alive: value["alive"].as_bool().unwrap_or_default(),
        project_id: value
            .get("projectId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        project_root: value
            .get("projectRoot")
            .and_then(Value::as_str)
            .map(str::to_owned),
        project_name: value
            .get("projectName")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

fn options(input: &Value) -> ExposeOrderingOptions {
    let options = input.get("options").unwrap_or(&Value::Null);
    let mut worktree_order_by_project_root = BTreeMap::new();
    if let Some(map) = options
        .get("worktreeOrderByProjectRoot")
        .and_then(Value::as_object)
    {
        for (root, paths) in map {
            worktree_order_by_project_root.insert(
                root.clone(),
                paths
                    .as_array()
                    .expect("worktree order paths")
                    .iter()
                    .map(|path| path.as_str().expect("worktree path").to_owned())
                    .collect(),
            );
        }
    }
    ExposeOrderingOptions {
        worktree_order_by_project_root,
        sort_mode_recent_output: options
            .get("sortMode")
            .and_then(Value::as_str)
            .is_some_and(|mode| mode == "recent-output"),
    }
}

fn sublabel(value: &str) -> ExposeSublabel {
    match value {
        "none" => ExposeSublabel::None,
        "worktree" => ExposeSublabel::Worktree,
        "project-worktree" => ExposeSublabel::ProjectWorktree,
        unexpected => panic!("unexpected sublabel {unexpected}"),
    }
}

fn groups(groups: Vec<aimux::project_service::expose_ordering::ExposeGroup>) -> Vec<Value> {
    groups
        .into_iter()
        .map(|group| json!({ "label": group.label, "itemIds": item_ids(&group.items) }))
        .collect()
}

fn item_ids(items: &[SwitchableAgentItem]) -> Vec<String> {
    items
        .iter()
        .map(|item| {
            item.target["windowId"]
                .as_str()
                .expect("window id")
                .to_owned()
        })
        .collect()
}

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} string"))
}
