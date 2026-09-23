//! One input, every surface that lists agents, one assertion.
//!
//! A test per surface passes happily while the surfaces disagree, which is
//! exactly how this class survived: the dashboard sorted by `createdAt`
//! descending, the chips by team order then `createdAt` ascending, and the
//! supervisor lane by role display order. Each had a green test.
//!
//! So this compares the surfaces against each other. The fixture's tmux window
//! order deliberately contradicts creation order, role, and worktree grouping,
//! so any surface that falls back to one of those breaks here.

mod support;

use aimux::project_service::desktop_state::{
    DesktopStateInput, build_desktop_state_with_live_window_ids,
};
use aimux::project_service::expose_ordering::{
    ExposeOrderingOptions, ExposeSublabel, order_expose_items,
};
use aimux::project_service::switchable_agents::{
    AgentListScope, SwitchableContext, SwitchableListOptions, list_switchable_agent_items,
    resolve_next_agent, topology_switchable_entries_for_context,
};
use aimux::runtime_topology::coerce_runtime_topology;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;

const PROJECT_ROOT: &str = "/repo";

/// Window order, creation order and worktree grouping all disagree on purpose.
/// `overseer` is created LAST but holds the lowest window; `wt-early` is
/// created first but sits late; the two worktrees interleave, because agents in
/// one worktree do not own a contiguous block of tmux windows.
struct Agent {
    id: &'static str,
    window_index: i64,
    created_at: &'static str,
    worktree: &'static str,
    supervisor: bool,
}

const AGENTS: &[Agent] = &[
    Agent {
        id: "overseer",
        window_index: 4,
        created_at: "2026-01-09T00:00:00.000Z",
        worktree: PROJECT_ROOT,
        supervisor: true,
    },
    Agent {
        id: "wt-late",
        window_index: 1,
        created_at: "2026-01-05T00:00:00.000Z",
        worktree: "/repo/.aimux/worktrees/feature",
        supervisor: false,
    },
    Agent {
        id: "main-mid",
        window_index: 2,
        created_at: "2026-01-03T00:00:00.000Z",
        worktree: PROJECT_ROOT,
        supervisor: false,
    },
    Agent {
        id: "wt-early",
        window_index: 3,
        created_at: "2026-01-01T00:00:00.000Z",
        worktree: "/repo/.aimux/worktrees/feature",
        supervisor: false,
    },
    Agent {
        id: "main-last",
        window_index: 5,
        created_at: "2026-01-07T00:00:00.000Z",
        worktree: PROJECT_ROOT,
        supervisor: false,
    },
    Agent {
        id: "main-tail",
        window_index: 6,
        created_at: "2026-01-02T00:00:00.000Z",
        worktree: PROJECT_ROOT,
        supervisor: false,
    },
];

/// The ungrouped list every surface starts from: pure tmux window order. The
/// overseer sits in the middle of it on purpose, so "the supervisor plane comes
/// first" is a claim about GROUPING that this order cannot accidentally satisfy.
/// Nothing here is creation order, and nothing groups by worktree.
const CANONICAL: &[&str] = &[
    "wt-late",
    "main-mid",
    "wt-early",
    "overseer",
    "main-last",
    "main-tail",
];

fn lane(agent: &Agent) -> Value {
    if agent.supervisor {
        json!({ "kind": "supervisor" })
    } else {
        json!({ "kind": "worktree", "worktreePath": agent.worktree })
    }
}

fn topology() -> Value {
    // Listed newest-first, so a surface that renders its input order fails.
    let mut ordered = AGENTS.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| right.created_at.cmp(left.created_at));
    let sessions = ordered
        .iter()
        .map(|agent| {
            json!({
                "id": agent.id,
                "nodeId": format!("node-{}", agent.id),
                "tool": "claude",
                "toolConfigKey": "claude",
                "command": "claude",
                "args": [],
                "label": agent.id,
                "worktreePath": agent.worktree,
                "lane": lane(agent),
                "status": "running",
                "createdAt": agent.created_at,
                "updatedAt": agent.created_at,
            })
        })
        .collect::<Vec<_>>();
    let nodes = ordered
        .iter()
        .map(|agent| {
            json!({
                "id": format!("node-{}", agent.id),
                "rigId": "rig-1",
                "logicalId": agent.id,
                "toolConfigKey": "claude",
                "cwd": agent.worktree,
                "createdAt": agent.created_at,
            })
        })
        .collect::<Vec<_>>();
    let bindings = ordered
        .iter()
        .map(|agent| {
            json!({
                "id": format!("tmux:{}", agent.id),
                "nodeId": format!("node-{}", agent.id),
                "tmuxSession": "aimux",
                "tmuxWindowId": format!("@{}", agent.window_index),
                "tmuxWindowIndex": agent.window_index,
                "tmuxWindowName": agent.id,
                "updatedAt": agent.created_at,
            })
        })
        .collect::<Vec<_>>();
    coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-10T00:00:00.000Z",
        "rigs": [{
            "id": "rig-1",
            "name": "repo",
            "projectRoot": PROJECT_ROOT,
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
        }],
        "nodes": nodes,
        "edges": [],
        "bindings": bindings,
        "sessions": sessions,
        "services": [],
        "worktrees": [{
            "id": "worktree-feature",
            "rigId": "rig-1",
            "path": "/repo/.aimux/worktrees/feature",
            "name": "feature",
            "branch": "feature",
            "createdAt": "2026-01-02T00:00:00.000Z",
            "updatedAt": "2026-01-02T00:00:00.000Z",
        }],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": [],
    }))
    .expect("coerce topology")
}

fn metadata_sessions() -> BTreeMap<String, Value> {
    AGENTS
        .iter()
        .map(|agent| {
            (
                agent.id.to_owned(),
                json!({
                    "id": agent.id,
                    "lane": lane(agent),
                    "worktreePath": agent.worktree,
                    "createdAt": agent.created_at,
                }),
            )
        })
        .collect()
}

fn live_windows() -> aimux::tmux::LiveWindowIndex {
    let ids = AGENTS
        .iter()
        .map(|agent| format!("@{}", agent.window_index))
        .collect::<Vec<_>>();
    support::live_windows("aimux", &ids.iter().map(String::as_str).collect::<Vec<_>>())
}

/// A surface may filter, group, truncate and index. It may not reorder. So the
/// only honest assertion is that what it emits reads down the canonical list.
#[track_caller]
fn assert_is_subsequence_of_canonical(surface: &str, emitted: &[String]) {
    let mut canonical = CANONICAL.iter();
    for id in emitted {
        assert!(
            canonical.any(|candidate| candidate == id),
            "{surface} emitted {emitted:?}, which is not in canonical order {CANONICAL:?}"
        );
    }
}

/// A surface that shows one agent, or none, agrees with every ordering. Say so
/// where the surface is asserted, not inside a plane that legitimately holds one.
#[track_caller]
fn assert_spans_enough_to_prove_an_order(surface: &str, emitted: &[String]) {
    assert!(
        emitted.len() >= 2,
        "{surface} emitted {emitted:?}, too few agents to prove any ordering"
    );
}

fn desktop_state() -> Value {
    build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: PROJECT_ROOT.to_owned(),
            topology: &topology(),
            metadata_sessions: &metadata_sessions(),
            exchange: &json!({}),
        },
        Some(&live_windows()),
    )
}

fn ids_of(sessions: &[Value]) -> Vec<String> {
    sessions
        .iter()
        .filter_map(|session| session.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .collect()
}

#[test]
fn the_gui_payload_lists_agents_in_canonical_order() {
    let state = desktop_state();
    let sessions = state["sessions"].as_array().cloned().unwrap_or_default();
    let emitted = ids_of(&sessions);

    assert_eq!(
        emitted, CANONICAL,
        "the GUI is handed the order, and this is it"
    );
}

#[test]
fn the_worktree_groups_partition_the_same_order_without_reordering_it() {
    let state = desktop_state();
    let groups = state["worktreeGroups"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut flattened = Vec::new();
    for group in &groups {
        let sessions = group["sessions"].as_array().cloned().unwrap_or_default();
        let ids = ids_of(&sessions);
        // Each group on its own reads down the canonical list. Together they do
        // not, because grouping is a partition and the planes interleave.
        assert_is_subsequence_of_canonical("a worktree group", &ids);
        flattened.extend(ids);
    }
    let supervisor = state["supervisorLane"]["sessions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    flattened.extend(ids_of(&supervisor));

    let mut seen = flattened.clone();
    seen.sort();
    let mut expected = CANONICAL
        .iter()
        .map(|id| (*id).to_owned())
        .collect::<Vec<_>>();
    expected.sort();
    assert_eq!(seen, expected, "grouping drops or duplicates no agent");
    assert!(
        groups.len() > 1,
        "the fixture has to actually span more than one group or this proves nothing"
    );
}

#[test]
fn the_footer_chips_read_in_the_same_order_as_the_payload_they_render() {
    let state = desktop_state();
    let rendered = aimux::project_service::statusline::render_tmux_statusline_contract(&json!({
        "data": state,
        "projectRoot": PROJECT_ROOT,
        "line": "bottom",
        "options": { "currentPath": PROJECT_ROOT, "width": 400 },
    }));
    let text = rendered["text"]
        .as_str()
        .expect("statusline text")
        .to_owned();

    let mut rendered_ids = CANONICAL
        .iter()
        .filter_map(|id| text.find(id).map(|position| (position, (*id).to_owned())))
        .collect::<Vec<_>>();
    assert!(
        rendered_ids.len() >= 2,
        "the chips have to render at least two agents to say anything: {text}"
    );
    rendered_ids.sort_by_key(|(position, _)| *position);
    let emitted = rendered_ids
        .into_iter()
        .map(|(_, id)| id)
        .collect::<Vec<_>>();

    assert_spans_enough_to_prove_an_order("the footer chips", &emitted);
    assert_is_subsequence_of_canonical("the footer chips", &emitted);
}

#[test]
fn expose_and_next_previous_walk_the_same_order_as_the_dashboard() {
    let isolation = support::TestIsolation::new("agent-order-across-surfaces");
    let project_root = isolation.root().join("repo");
    let state_dir = isolation.root().join("state");
    fs::create_dir_all(project_root.join(".git")).expect("git marker");
    fs::create_dir_all(&state_dir).expect("state dir");
    let context = isolation
        .project_context(&project_root, &state_dir)
        .with_live_windows(live_windows());

    let topology = topology();
    let metadata = metadata_sessions();
    let projection = topology_switchable_entries_for_context(&context, &topology, &metadata);
    let switch_context = SwitchableContext {
        project_root: PROJECT_ROOT.into(),
        current_path: Some(PROJECT_ROOT.into()),
        current_window: None,
        // main-mid, so n/p's own filter yields the three main-checkout agents.
        // Two would read the same forwards and backwards.
        current_window_id: Some("@2".into()),
        current_client_session: Some("client-1".into()),
    };
    // n/p keeps its own filter -- the current worktree, no supervisor plane --
    // while Exposé spans every plane. Both take the shared order as input.
    let options = SwitchableListOptions::default();
    let every_plane = SwitchableListOptions {
        scope: AgentListScope::All,
        use_expose_role_visibility: true,
        ..SwitchableListOptions::default()
    };
    let last_used = json!({});

    let items = list_switchable_agent_items(
        &projection.entries,
        &metadata,
        &switch_context,
        &options,
        &last_used,
    );
    let switchable = items.iter().map(|item| item.id.clone()).collect::<Vec<_>>();
    assert_spans_enough_to_prove_an_order("the switcher", &switchable);
    assert_is_subsequence_of_canonical("the switcher", &switchable);
    assert!(
        switchable.len() < CANONICAL.len(),
        "the switcher's filter has to actually drop an agent, or this proves nothing about filtering"
    );

    let every_agent = list_switchable_agent_items(
        &projection.entries,
        &metadata,
        &switch_context,
        &every_plane,
        &last_used,
    );
    let exposed = order_expose_items(
        &every_agent,
        PROJECT_ROOT,
        ExposeSublabel::Worktree,
        &ExposeOrderingOptions::default(),
    )
    .into_iter()
    .map(|item| item.id)
    .collect::<Vec<_>>();
    // Exposé groups: the supervisor plane, then each worktree, planes adjacent.
    // Grouping is a partition, so the flattened list is NOT canonical -- but
    // every plane read on its own has to be.
    assert_eq!(
        exposed.len(),
        CANONICAL.len(),
        "Exposé across every plane has to show every agent, got {exposed:?}"
    );
    assert_eq!(
        exposed.first().map(String::as_str),
        Some("overseer"),
        "the supervisor plane leads, got {exposed:?}"
    );
    assert_spans_enough_to_prove_an_order("Exposé", &exposed);
    let planes = planes_of(&exposed);
    // Contiguity matters: scattered planes would degrade into one-element runs
    // that satisfy a subsequence check vacuously.
    assert_eq!(
        planes.len(),
        3,
        "the supervisor plane and two worktrees, each contiguous, got {planes:?}"
    );
    for plane in planes {
        assert_is_subsequence_of_canonical("an Exposé plane", &plane);
    }

    // n/p keeps its own filter and must still walk the shared order. Stepping
    // from each agent in turn has to trace the switcher's list, wrapping once.
    // n/p keeps its own filter and must still walk the shared order. Stepping
    // from each agent in turn has to trace the switcher's list exactly, wrapping
    // once. A `filter_map` here would hide a step that resolved nothing and
    // shift every comparison after it, so resolve eagerly and demand a result.
    let walked = switchable
        .iter()
        .map(|id| {
            let mut stepping = switch_context.clone();
            stepping.current_window_id = Some(format!("@{}", window_index_of(id)));
            resolve_next_agent(
                &projection.entries,
                &metadata,
                &stepping,
                &options,
                &last_used,
            )
            .map(|item| item.id)
            .unwrap_or_else(|| panic!("n from {id} resolved no next agent"))
        })
        .collect::<Vec<_>>();
    assert_eq!(walked.len(), switchable.len(), "every step has to resolve");
    assert!(
        switchable.len() >= 3,
        "a two-agent cycle reads the same forwards and backwards, so n/p proves \
         nothing: {switchable:?}"
    );
    for (index, next) in walked.iter().enumerate() {
        let expected = &switchable[(index + 1) % switchable.len()];
        assert_eq!(
            next, expected,
            "n from {} must reach the next agent in the shared order, not {next}",
            switchable[index]
        );
    }
}

fn window_index_of(id: &str) -> i64 {
    AGENTS
        .iter()
        .find(|agent| agent.id == id)
        .map(|agent| agent.window_index)
        .unwrap_or_default()
}

/// Split a rendered list into its contiguous planes. Exposé puts planes next to
/// each other, so each run of one plane is what has to read canonically.
fn planes_of(emitted: &[String]) -> Vec<Vec<String>> {
    let plane_of = |id: &str| {
        AGENTS
            .iter()
            .find(|agent| agent.id == id)
            .map(|agent| {
                if agent.supervisor {
                    "supervisor".to_owned()
                } else {
                    agent.worktree.to_owned()
                }
            })
            .unwrap_or_default()
    };
    let mut planes: Vec<Vec<String>> = Vec::new();
    let mut current = String::new();
    for id in emitted {
        let plane = plane_of(id);
        if plane != current || planes.is_empty() {
            planes.push(Vec::new());
            current = plane;
        }
        planes.last_mut().expect("plane started").push(id.clone());
    }
    planes
}
