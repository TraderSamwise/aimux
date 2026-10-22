use aimux::project_api_contract::routes;
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::usage::last_used_path;
use aimux::project_service::worktrees::{GraveyardViewModelInput, build_graveyard_view_model};
use aimux::runtime_topology::{coerce_runtime_topology, runtime_topology_path};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn worktrees_route_prefers_injected_desktop_state() {
    let project = temp_project("desktop-worktrees");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_desktop_state(json!({
            "worktrees": [
                { "name": "main", "path": "/repo", "branch": "master", "isBare": false }
            ]
        }));

    let response = route_project_service_request(&context, "GET", routes::WORKTREES, None);
    assert_eq!(response.status, 200);
    assert_eq!(
        response.body,
        json!({
            "ok": true,
            "worktrees": [
                { "name": "main", "path": "/repo", "branch": "master", "isBare": false }
            ]
        })
    );
    cleanup(project);
}

#[test]
fn worktrees_route_falls_back_to_runtime_topology_without_graveyard_rows() {
    let project = temp_project("topology-worktrees");
    let state_dir = project.join("state");
    write_topology(&state_dir, topology_fixture());
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(&context, "GET", routes::WORKTREES, None);
    assert_eq!(response.status, 200);
    assert_eq!(
        response.body["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .map(|worktree| worktree["path"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["/repo"]
    );
    cleanup(project);
}

#[test]
fn graveyard_route_returns_entries_worktrees_and_view_model() {
    let project = temp_project("graveyard-route");
    let state_dir = project.join("state");
    write_topology(&state_dir, topology_fixture());
    create_dir_all(&state_dir).unwrap();
    write(
        last_used_path(&state_dir),
        json!({
            "version": 1,
            "items": {
                "agent-attached": { "lastUsedAt": "2026-01-01T00:00:09.000Z" },
                "svc-1": { "lastUsedAt": "2026-01-01T00:00:08.000Z" }
            },
            "clients": {},
            "projectRecentIds": []
        })
        .to_string(),
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(&context, "GET", routes::GRAVEYARD, None);
    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert_eq!(response.body["entries"].as_array().unwrap().len(), 2);
    assert_eq!(response.body["worktrees"].as_array().unwrap().len(), 1);
    assert_eq!(response.body["worktrees"][0]["name"], "old");
    assert_eq!(
        response.body["worktrees"][0]["agents"][0]["id"],
        "agent-attached"
    );
    assert_eq!(response.body["worktrees"][0]["services"][0]["id"], "svc-1");

    let rows = response.body["viewModel"]["rows"].as_array().unwrap();
    assert_eq!(rows[0], json!({ "kind": "section", "label": "Worktrees" }));
    assert!(
        rows.iter()
            .any(|row| row["kind"] == "attached-agent-display"
                && row["agent"]["entry"]["id"] == "agent-attached")
    );
    assert!(
        rows.iter()
            .any(|row| row["kind"] == "attached-service-display"
                && row["service"]["entry"]["id"] == "svc-1")
    );
    assert!(
        rows.iter()
            .any(|row| row["kind"] == "orphan-agent" && row["entry"]["id"] == "agent-orphan")
    );
    assert_eq!(
        response.body["viewModel"]["selectableRows"][0]["actionNumber"],
        1
    );
    cleanup(project);
}

#[test]
fn graveyard_view_model_groups_and_caps_attached_agents() {
    let agents = (0..7)
        .map(|index| {
            json!({
                "id": format!("agent-{index}"),
                "worktreePath": "/repo/old",
                "createdAt": format!("2026-01-01T00:00:0{index}.000Z")
            })
        })
        .collect::<Vec<_>>();
    let model = build_graveyard_view_model(GraveyardViewModelInput {
        agents,
        worktrees: vec![json!({
            "name": "old",
            "path": "/repo/old",
            "branch": "old",
            "graveyardedAt": "2026-01-01T00:00:10.000Z",
            "agents": [],
            "services": []
        })],
        parent_sessions: vec![],
        teammates: vec![json!({
            "id": "orphan-teammate",
            "team": { "parentSessionId": "missing", "order": 1 },
            "createdAt": "2026-01-01T00:00:11.000Z"
        })],
        last_used_by_id: json!({}),
        metadata_sessions: BTreeMap::new(),
    });

    let worktree_row = model["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "worktree")
        .unwrap();
    assert_eq!(worktree_row["attachedAgents"].as_array().unwrap().len(), 7);
    assert_eq!(
        worktree_row["visibleAttachedAgents"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    assert_eq!(worktree_row["hiddenAttachedAgentCount"], 2);
    assert!(
        model["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["kind"] == "orphan-teammate" && row["entry"]["id"] == "orphan-teammate")
    );
    let orphan = model["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "orphan-teammate")
        .unwrap();
    assert!(!orphan.as_object().unwrap().contains_key("lastUsedAt"));
}

fn write_topology(state_dir: &PathBuf, topology: Value) {
    create_dir_all(state_dir).unwrap();
    write(
        runtime_topology_path(state_dir),
        serde_yaml::to_string(&topology).unwrap(),
    )
    .unwrap();
}

fn topology_fixture() -> Value {
    coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-attached", "rigId": "rig-1", "logicalId": "agent-attached", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-orphan", "rigId": "rig-1", "logicalId": "agent-orphan", "toolConfigKey": "claude", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "service:svc-1", "rigId": "rig-1", "logicalId": "svc-1", "role": "service", "runtime": "service", "toolConfigKey": "service", "label": "web", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [],
        "sessions": [
            { "id": "agent-attached", "nodeId": "node-attached", "status": "graveyard", "command": "codex", "worktreePath": "/repo/old", "createdAt": "2026-01-01T00:00:03.000Z", "updatedAt": "2026-01-01T00:00:03.000Z" },
            { "id": "agent-orphan", "nodeId": "node-orphan", "status": "graveyard", "command": "claude", "createdAt": "2026-01-01T00:00:04.000Z", "updatedAt": "2026-01-01T00:00:04.000Z" }
        ],
        "services": [
            { "id": "svc-1", "rigId": "rig-1", "nodeId": "service:svc-1", "status": "stopped", "command": "yarn dev", "worktreePath": "/repo/old", "createdAt": "2026-01-01T00:00:02.000Z", "updatedAt": "2026-01-01T00:00:02.000Z" }
        ],
        "worktrees": [
            { "id": "main", "rigId": "rig-1", "path": "/repo", "name": "main", "status": "active", "branch": "master", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "old", "rigId": "rig-1", "path": "/repo/old", "name": "old", "status": "graveyard", "branch": "old", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z", "removedAt": "2026-01-01T00:00:05.000Z" }
        ],
        "worktreeGraveyard": [
            { "id": "graveyard-old", "rigId": "rig-1", "worktreeId": "old", "path": "/repo/old", "name": "old", "branch": "old", "graveyardedAt": "2026-01-01T00:00:05.000Z" },
            { "id": "deleted", "rigId": "rig-1", "path": "/repo/deleted", "graveyardedAt": "2026-01-01T00:00:06.000Z", "deletedAt": "2026-01-01T00:00:07.000Z" }
        ],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap()
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-project-service-worktrees-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}

/// Agents inside a worktree read down the class ladder, and the flags that
/// decide the ladder live in metadata rather than in the topology row.
///
/// `upsert_agent_topology` persists an agent's `role` but not
/// `projectControl`, and the control rung is the one that asks for
/// `projectControl`. So a control agent ordered off the bare row is
/// indistinguishable from a coder, which is why the model takes the stored
/// flags and merges them.
#[test]
fn worktree_agents_read_down_the_class_ladder_from_stored_flags() {
    // Deliberately reversed against the ladder: the coder is the most recently
    // used and the newest, so recency alone would lead with it.
    let agents = vec![
        json!({
            "id": "coder-1",
            "worktreePath": "/repo/old",
            "createdAt": "2026-01-01T00:00:09.000Z",
        }),
        json!({
            "id": "scribe-1",
            "worktreePath": "/repo/old",
            "createdAt": "2026-01-01T00:00:03.000Z",
        }),
        json!({
            "id": "control-1",
            "worktreePath": "/repo/old",
            "createdAt": "2026-01-01T00:00:02.000Z",
        }),
        json!({
            "id": "overseer-1",
            "worktreePath": "/repo/old",
            "createdAt": "2026-01-01T00:00:01.000Z",
        }),
    ];
    let worktree = json!({
        "name": "old",
        "path": "/repo/old",
        "branch": "old",
        "graveyardedAt": "2026-01-01T00:00:10.000Z",
        "agents": [],
        "services": []
    });
    let metadata_sessions = BTreeMap::from([
        (
            "overseer-1".to_owned(),
            json!({ "overseer": true, "projectControl": true, "role": "overseer" }),
        ),
        (
            "scribe-1".to_owned(),
            json!({ "scribe": true, "projectControl": true, "role": "scribe" }),
        ),
        // The control rung: project control with no overseer or scribe flag,
        // which is what a supervisor-target launch stores.
        (
            "control-1".to_owned(),
            json!({ "projectControl": true, "role": "control" }),
        ),
    ]);

    let ordered = |metadata_sessions: BTreeMap<String, Value>| {
        let model = build_graveyard_view_model(GraveyardViewModelInput {
            agents: agents.clone(),
            worktrees: vec![worktree.clone()],
            parent_sessions: vec![],
            teammates: vec![],
            last_used_by_id: json!({
                "coder-1": { "lastUsedAt": "2026-02-01T00:00:00.000Z" }
            }),
            metadata_sessions,
        });
        model["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .find(|row| row["kind"] == "worktree")
            .expect("worktree row")["attachedAgents"]
            .as_array()
            .expect("attached agents")
            .iter()
            .map(|view| view["entry"]["id"].as_str().unwrap_or_default().to_owned())
            .collect::<Vec<_>>()
    };

    assert_eq!(
        ordered(metadata_sessions),
        ["overseer-1", "control-1", "scribe-1", "coder-1"],
        "class leads, although the coder is both the newest and the most recently used"
    );

    // Without the stored flags there is no class to read, so the screen falls
    // back to the recency order it had before the ladder existed rather than
    // inventing one.
    assert_eq!(
        ordered(BTreeMap::new()),
        ["coder-1", "scribe-1", "control-1", "overseer-1"],
        "most recently used first, then newest first"
    );
}

/// The orphan list is a second ordering path through this model, and it needs
/// the ladder too.
///
/// An agent with no `worktreePath` is not claimed by any worktree, so it lands
/// under "Orphaned Agents" through `sort_agents` rather than through the
/// attached-agent comparator. Those rows carry the action keys the screen is
/// driven by, so an order that only held for attached agents would renumber
/// half the screen differently from the other half.
#[test]
fn orphaned_agents_read_down_the_same_class_ladder() {
    let agents = vec![
        json!({ "id": "orphan-coder", "createdAt": "2026-01-01T00:00:09.000Z" }),
        json!({ "id": "orphan-scribe", "createdAt": "2026-01-01T00:00:03.000Z" }),
        json!({ "id": "orphan-overseer", "createdAt": "2026-01-01T00:00:01.000Z" }),
    ];
    let model = build_graveyard_view_model(GraveyardViewModelInput {
        agents,
        worktrees: vec![],
        parent_sessions: vec![],
        teammates: vec![],
        // The coder is the most recently used, so recency alone leads with it.
        last_used_by_id: json!({
            "orphan-coder": { "lastUsedAt": "2026-02-01T00:00:00.000Z" }
        }),
        metadata_sessions: BTreeMap::from([
            (
                "orphan-overseer".to_owned(),
                json!({ "overseer": true, "projectControl": true, "role": "overseer" }),
            ),
            (
                "orphan-scribe".to_owned(),
                json!({ "scribe": true, "projectControl": true, "role": "scribe" }),
            ),
        ]),
    });

    let rows = model["rows"].as_array().expect("rows");
    let ordered = rows
        .iter()
        .filter(|row| row["kind"] == "orphan-agent")
        .map(|row| row["entry"]["id"].as_str().unwrap_or_default().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        ordered,
        ["orphan-overseer", "orphan-scribe", "orphan-coder"],
        "class leads, although the coder is the most recently used"
    );

    // The action keys follow the rows, so they have to follow the class order
    // too rather than being assigned off some earlier sequence.
    let numbered = rows
        .iter()
        .filter(|row| row["kind"] == "orphan-agent")
        .filter_map(|row| {
            Some((
                row["entry"]["id"].as_str()?.to_owned(),
                row["actionNumber"].as_i64()?,
            ))
        })
        .collect::<Vec<_>>();
    assert!(
        numbered.windows(2).all(|pair| pair[0].1 < pair[1].1),
        "action numbers ascend with the rendered order: {numbered:?}"
    );
}

/// The order has to be in the array, not only in the rows beside it.
///
/// The CLI renders `entries` and `worktrees` straight from this response, and
/// the daemon's text route rebuilds the payload as `{entries, worktrees}` with
/// no view model at all, so an order that lived only in `viewModel` reached
/// the TUI and nothing else. The Expo graveyard reads `entries` too and never
/// sorts.
#[test]
fn graveyard_route_orders_the_raw_entries_by_class() {
    let project = temp_project("graveyard-route-class-order");
    let state_dir = project.join("state");
    // A second agent in the graveyarded worktree, so the nested list spans
    // enough to prove an order. The shared fixture has one, and a one-agent
    // list agrees with every ordering.
    let mut topology = topology_fixture();
    topology["nodes"]
        .as_array_mut()
        .expect("nodes")
        .push(json!({
            "id": "node-wt-overseer",
            "rigId": "rig-1",
            "logicalId": "agent-wt-overseer",
            "toolConfigKey": "claude",
            "createdAt": "2026-01-01T00:00:00.000Z"
        }));
    topology["sessions"]
        .as_array_mut()
        .expect("sessions")
        .push(json!({
            "id": "agent-wt-overseer",
            "nodeId": "node-wt-overseer",
            "status": "graveyard",
            "command": "claude",
            "worktreePath": "/repo/old",
            "createdAt": "2026-01-01T00:00:02.000Z",
            "updatedAt": "2026-01-01T00:00:02.000Z"
        }));
    write_topology(&state_dir, topology);
    create_dir_all(&state_dir).unwrap();
    write(
        last_used_path(&state_dir),
        json!({
            "version": 1,
            // The coder is the most recently used, so recency alone leads with it.
            "items": { "agent-attached": { "lastUsedAt": "2026-01-01T00:00:09.000Z" } },
            "clients": {},
            "projectRecentIds": []
        })
        .to_string(),
    )
    .unwrap();
    // Promotion writes metadata state, never the topology file, so this is the
    // only place the class can come from.
    write(
        aimux::daemon_state::metadata_state_path(&state_dir),
        json!({
            "version": 1,
            "sessions": {
                "agent-wt-overseer": {
                    "id": "agent-wt-overseer",
                    "overseer": true,
                    "projectControl": true,
                    "role": "overseer"
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(&context, "GET", routes::GRAVEYARD, None);
    assert_eq!(response.status, 200);
    let ids = response.body["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .map(|entry| entry["id"].as_str().unwrap_or_default().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        ["agent-wt-overseer", "agent-attached", "agent-orphan"],
        "the overseer leads although agent-attached is the most recently used"
    );

    // The same payload carries a worktree's agents a second time, and the view
    // model a third. All three have to read the same way.
    let nested = response.body["worktrees"][0]["agents"]
        .as_array()
        .expect("nested worktree agents")
        .iter()
        .map(|agent| agent["id"].as_str().unwrap_or_default().to_owned())
        .collect::<Vec<_>>();
    let attached = response.body["viewModel"]["rows"]
        .as_array()
        .expect("rows")
        .iter()
        .find(|row| row["kind"] == "worktree")
        .expect("worktree row")["attachedAgents"]
        .as_array()
        .expect("attached agents")
        .iter()
        .map(|view| view["entry"]["id"].as_str().unwrap_or_default().to_owned())
        .collect::<Vec<_>>();
    assert!(
        nested.len() >= 2,
        "a one-agent worktree agrees with every order, so this would prove nothing: {nested:?}"
    );
    assert_eq!(
        nested, attached,
        "the nested agents array and the view model's attachedAgents are one order"
    );
    cleanup(project);
}
