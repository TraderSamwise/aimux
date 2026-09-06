use aimux::dashboard_actions::DashboardActionRequest;
use aimux::dashboard_create::{
    DashboardAgentCreateIntent, DashboardCreateBlocked, DashboardCreateIntent, DashboardCreatePlan,
    DashboardServiceCreateIntent, plan_dashboard_create,
};
use aimux::project_api_contract::routes;
use serde_json::json;

#[test]
fn selected_agent_tool_maps_to_project_service_spawn_request() {
    let intent = DashboardCreateIntent::Agent(DashboardAgentCreateIntent {
        tool: Some("codex".into()),
        session_id: Some("codex-7f2e1a".into()),
        worktree_path: Some("/repo/feature".into()),
        launch_override: Some(json!({
            "command": "codex",
            "args": ["--profile", "fast"],
            "env": { "CODEX_FLAG": "1" }
        })),
        overseer: Some(false),
        scribe: Some(true),
    });

    assert_eq!(
        plan_dashboard_create(&intent),
        DashboardCreatePlan::Request(DashboardActionRequest {
            method: "POST",
            path: routes::agents::SPAWN,
            body: json!({
                "tool": "codex",
                "sessionId": "codex-7f2e1a",
                "worktreePath": "/repo/feature",
                "launchOverride": {
                    "command": "codex",
                    "args": ["--profile", "fast"],
                    "env": { "CODEX_FLAG": "1" }
                },
                "overseer": false,
                "scribe": true,
                "open": false
            }),
        })
    );
}

#[test]
fn agent_without_selected_tool_requires_the_picker() {
    let intent = DashboardCreateIntent::Agent(DashboardAgentCreateIntent {
        tool: None,
        session_id: Some("codex-7f2e1a".into()),
        worktree_path: None,
        launch_override: None,
        overseer: None,
        scribe: None,
    });

    assert_eq!(
        plan_dashboard_create(&intent),
        DashboardCreatePlan::Blocked(DashboardCreateBlocked::ToolPickerRequired)
    );
}

#[test]
fn service_command_maps_to_project_service_create_request_without_defaults() {
    let intent = DashboardCreateIntent::Service(DashboardServiceCreateIntent {
        command: Some("yarn dev --host 0.0.0.0".into()),
        service_id: Some("service-web".into()),
        worktree_path: Some("/repo/apps/web".into()),
    });

    assert_eq!(
        plan_dashboard_create(&intent),
        DashboardCreatePlan::Request(DashboardActionRequest {
            method: "POST",
            path: routes::services::CREATE,
            body: json!({
                "serviceId": "service-web",
                "command": "yarn dev --host 0.0.0.0",
                "worktreePath": "/repo/apps/web"
            }),
        })
    );
}

#[test]
fn absent_service_command_requires_interactive_input() {
    let intent = DashboardCreateIntent::Service(DashboardServiceCreateIntent {
        command: None,
        service_id: Some("service-web".into()),
        worktree_path: None,
    });

    assert_eq!(
        plan_dashboard_create(&intent),
        DashboardCreatePlan::Blocked(DashboardCreateBlocked::ServiceCommandInputRequired)
    );
}

#[test]
fn blank_service_command_maps_to_interactive_shell_create() {
    let intent = DashboardCreateIntent::Service(DashboardServiceCreateIntent {
        command: Some("".into()),
        service_id: None,
        worktree_path: None,
    });

    let DashboardCreatePlan::Request(request) = plan_dashboard_create(&intent) else {
        panic!("blank command should still create an interactive shell service");
    };

    assert_eq!(request.body, json!({ "command": "" }));
}

#[test]
fn backend_generated_ids_remain_available_without_inventing_values() {
    let agent = DashboardCreateIntent::Agent(DashboardAgentCreateIntent {
        tool: Some("claude".into()),
        session_id: None,
        worktree_path: None,
        launch_override: None,
        overseer: None,
        scribe: None,
    });
    let service = DashboardCreateIntent::Service(DashboardServiceCreateIntent {
        command: Some("yarn dev".into()),
        service_id: None,
        worktree_path: None,
    });

    let DashboardCreatePlan::Request(agent) = plan_dashboard_create(&agent) else {
        panic!("selected agent tool should produce a request");
    };
    let DashboardCreatePlan::Request(service) = plan_dashboard_create(&service) else {
        panic!("service command should produce a request");
    };
    assert_eq!(agent.body, json!({ "tool": "claude", "open": false }));
    assert_eq!(service.body, json!({ "command": "yarn dev" }));
}
