use aimux::project_service::expose_ordering::{
    ExposeOrderingOptions, ExposeSublabel, assign_worktree_tones, expose_tile_context_for_item,
    group_items_by_project, group_items_by_worktree, order_expose_items,
};
use aimux::project_service::switchable_agents::SwitchableAgentItem;
use serde_json::json;
use std::collections::BTreeMap;

#[test]
fn groups_projects_by_first_seen_order() {
    let groups = group_items_by_project(&[
        item("b1", Some("beta"), Some("/beta"), None, None, None),
        item("a1", Some("alpha"), Some("/alpha"), None, None, None),
        item("b2", Some("beta"), Some("/beta"), None, None, None),
        item("a2", Some("alpha"), Some("/alpha"), None, None, None),
    ]);

    assert_eq!(
        groups
            .iter()
            .map(|group| group.label.as_str())
            .collect::<Vec<_>>(),
        vec!["beta", "alpha"]
    );
    assert_eq!(
        groups[0]
            .items
            .iter()
            .map(|item| item.target["windowId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["b1", "b2"]
    );
}

#[test]
fn groups_worktrees_by_dashboard_order_and_keeps_item_order() {
    let options = ExposeOrderingOptions {
        worktree_order_by_project_root: BTreeMap::from([(
            "/repo".into(),
            vec![
                "/repo".into(),
                "/repo/.aimux/worktrees/custom".into(),
                "/repo/.aimux/worktrees/e2e-audit".into(),
            ],
        )]),
        sort_mode_recent_output: false,
    };
    let groups = group_items_by_worktree(
        &[
            item(
                "custom-1",
                None,
                None,
                Some("/repo/.aimux/worktrees/custom"),
                None,
                None,
            ),
            item("main-1", None, None, Some("/repo"), None, None),
            item(
                "custom-2",
                None,
                None,
                Some("/repo/.aimux/worktrees/custom"),
                None,
                None,
            ),
            item("main-2", None, None, Some("/repo"), None, None),
            item(
                "audit-1",
                None,
                None,
                Some("/repo/.aimux/worktrees/e2e-audit"),
                None,
                None,
            ),
        ],
        "/repo",
        &options,
    );

    assert_eq!(
        groups
            .iter()
            .map(|group| group.label.as_str())
            .collect::<Vec<_>>(),
        vec!["main", "custom", "e2e-audit"]
    );
    assert_eq!(
        groups[1]
            .items
            .iter()
            .map(|item| item.target["windowId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["custom-1", "custom-2"]
    );
}

#[test]
fn orders_global_items_by_project_then_worktree() {
    let options = ExposeOrderingOptions {
        worktree_order_by_project_root: BTreeMap::from([
            (
                "/beta".into(),
                vec!["/beta".into(), "/beta/.aimux/worktrees/custom".into()],
            ),
            ("/alpha".into(), vec!["/alpha".into()]),
        ]),
        sort_mode_recent_output: false,
    };
    let ordered = order_expose_items(
        &[
            item(
                "beta-custom-1",
                Some("beta"),
                Some("/beta"),
                Some("/beta/.aimux/worktrees/custom"),
                None,
                None,
            ),
            item(
                "alpha-main-1",
                Some("alpha"),
                Some("/alpha"),
                Some("/alpha"),
                None,
                None,
            ),
            item(
                "beta-main-1",
                Some("beta"),
                Some("/beta"),
                Some("/beta"),
                None,
                None,
            ),
            item(
                "alpha-main-2",
                Some("alpha"),
                Some("/alpha"),
                Some("/alpha"),
                None,
                None,
            ),
            item(
                "beta-custom-2",
                Some("beta"),
                Some("/beta"),
                Some("/beta/.aimux/worktrees/custom"),
                None,
                None,
            ),
        ],
        "/fallback",
        ExposeSublabel::ProjectWorktree,
        &options,
    );

    assert_eq!(
        ordered
            .iter()
            .map(|item| item.target["windowId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "beta-main-1",
            "beta-custom-1",
            "beta-custom-2",
            "alpha-main-1",
            "alpha-main-2"
        ]
    );
}

#[test]
fn sorts_recent_output_by_timestamp_rank_then_original_order() {
    let options = ExposeOrderingOptions {
        sort_mode_recent_output: true,
        ..ExposeOrderingOptions::default()
    };
    let ordered = order_expose_items(
        &[
            item(
                "older",
                None,
                None,
                Some("/repo"),
                Some("2026-08-27T10:00:00.000Z"),
                Some(2),
            ),
            item(
                "missing-timestamp-newer-rank",
                None,
                None,
                Some("/repo"),
                None,
                Some(0),
            ),
            item(
                "newer",
                None,
                None,
                Some("/repo/wt/a"),
                Some("2026-08-27T10:05:00.000Z"),
                Some(1),
            ),
            item(
                "missing-timestamp-older-rank",
                None,
                None,
                Some("/repo/wt/b"),
                None,
                Some(3),
            ),
        ],
        "/repo",
        ExposeSublabel::ProjectWorktree,
        &options,
    );

    assert_eq!(
        ordered
            .iter()
            .map(|item| item.target["windowId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "newer",
            "older",
            "missing-timestamp-newer-rank",
            "missing-timestamp-older-rank"
        ]
    );
}

#[test]
fn expose_context_uses_worktree_and_stable_tone_identity() {
    let items = vec![
        item("a", None, None, Some("/p/a"), None, None),
        item("b", None, None, Some("/p/b"), None, None),
        item("a2", None, None, Some("/p/a"), None, None),
    ];
    let tones = assign_worktree_tones(&items, "/p");
    let reordered = assign_worktree_tones(
        &[
            item("b", None, None, Some("/p/b"), None, None),
            item("a", None, None, Some("/p/a"), None, None),
        ],
        "/p",
    );

    assert_eq!(tones.get("/p/a"), reordered.get("/p/a"));
    assert_eq!(tones.get("/p/b"), reordered.get("/p/b"));
    assert_eq!(tones.len(), 2);
    assert_eq!(
        expose_tile_context_for_item(&items[0], ExposeSublabel::Worktree, "/p", &tones),
        json!({ "worktree": "a", "tone": tones["/p/a"] })
    );
}

fn item(
    id: &str,
    project_name: Option<&str>,
    project_root: Option<&str>,
    worktree_path: Option<&str>,
    recency_at: Option<&str>,
    recent_rank: Option<i64>,
) -> SwitchableAgentItem {
    let mut metadata = json!({
        "kind": "agent",
        "sessionId": id,
        "command": id,
        "args": [],
        "toolConfigKey": id,
        "label": id
    });
    if let Some(worktree_path) = worktree_path {
        metadata["worktreePath"] = json!(worktree_path);
    }
    if let Some(recency_at) = recency_at {
        metadata["recencyAt"] = json!(recency_at);
    }
    SwitchableAgentItem {
        id: id.into(),
        target: json!({ "sessionName": "aimux-repo", "windowId": id, "windowIndex": 1, "windowName": id }),
        metadata,
        label: id.into(),
        urgency: 0,
        activity: 1,
        last_used_at: None,
        recent_rank: recent_rank.unwrap_or(9_007_199_254_740_991),
        overseer: false,
        scribe: false,
        alive: true,
        project_id: None,
        project_root: project_root.map(str::to_owned),
        project_name: project_name.map(str::to_owned),
    }
}
