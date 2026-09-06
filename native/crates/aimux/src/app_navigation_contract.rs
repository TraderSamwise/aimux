use serde_json::{Value, json};

pub fn run_app_navigation_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    match api {
        "initialMainRoute" => json!(initial_main_route(
            input.get("value").unwrap_or(&Value::Null)
        )),
        "buildMainTabHref" => build_main_tab_href(
            input
                .get("tabId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            input
                .get("projectPath")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        "MAIN_TAB_ROUTES" => main_tab_route_value(
            input
                .get("tabId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        "mainTabForPath" => json!(main_tab_for_path(
            input
                .get("pathname")
                .and_then(Value::as_str)
                .unwrap_or_default()
        )),
        "filterProjectPickerProjects" => {
            filter_project_picker_projects(input.get("projects").unwrap_or(&Value::Null), input)
        }
        "hasKnownOnlineAgents" => json!(has_known_online_agents(
            input.get("project").unwrap_or(&Value::Null)
        )),
        _ => panic!("unknown app navigation contract api: {api}"),
    }
}

fn initial_main_route(value: &Value) -> &'static str {
    let is_signed_in = bool_field(value, "isSignedIn");
    let shared_chat_count = number_field(value, "realSharedChatCount");
    if !is_signed_in || shared_chat_count <= 0 {
        return "project";
    }

    let relay_configured = bool_field(value, "relayConfigured");
    let relay_status = value
        .get("relayStatus")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let cli_unavailable = relay_configured && relay_status != "connected";
    let no_active_projects = bool_field(value, "projectDiscoverySynced")
        && number_field(value, "activeProjectCount") == 0;

    if cli_unavailable || no_active_projects {
        "shared"
    } else {
        "project"
    }
}

fn build_main_tab_href(tab_id: &str, project_path: &str) -> Value {
    let route = main_tab_route(tab_id);
    let params = if project_path.is_empty() {
        json!({})
    } else {
        json!({ "project": project_path })
    };
    json!({ "pathname": route.internal_href, "params": params })
}

fn main_tab_route_value(tab_id: &str) -> Value {
    let route = main_tab_route(tab_id);
    json!({
        "id": route.id,
        "href": route.href,
        "internalHref": route.internal_href,
        "screen": route.screen,
    })
}

fn main_tab_for_path(pathname: &str) -> &'static str {
    for route in MAIN_TAB_ROUTES {
        if route.id == "dashboard" {
            continue;
        }
        if pathname == route.href || pathname.starts_with(&format!("{}/", route.href)) {
            return route.id;
        }
    }
    "dashboard"
}

fn filter_project_picker_projects(projects: &Value, input: &Value) -> Value {
    let show_all = input
        .get("options")
        .and_then(|options| options.get("showAll"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let ids: Vec<Value> = projects
        .as_array()
        .into_iter()
        .flatten()
        .filter(|project| show_all || has_known_online_agents(project))
        .filter_map(|project| project.get("id").and_then(Value::as_str))
        .map(|id| json!(id))
        .collect();
    json!(ids)
}

fn has_known_online_agents(project: &Value) -> bool {
    match project.get("onlineAgentCount").and_then(Value::as_i64) {
        Some(count) => count > 0,
        None => true,
    }
}

fn bool_field(value: &Value, field: &str) -> bool {
    value.get(field).and_then(Value::as_bool).unwrap_or(false)
}

fn number_field(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or(0)
}

#[derive(Debug, Clone, Copy)]
struct MainTabRoute {
    id: &'static str,
    href: &'static str,
    internal_href: &'static str,
    screen: &'static str,
}

const MAIN_TAB_ROUTES: &[MainTabRoute] = &[
    MainTabRoute {
        id: "dashboard",
        href: "/",
        internal_href: "/(main)/(tabs)/(dashboard)",
        screen: "(dashboard)",
    },
    MainTabRoute {
        id: "coordination",
        href: "/coordination",
        internal_href: "/(main)/(tabs)/coordination",
        screen: "coordination",
    },
    MainTabRoute {
        id: "expose",
        href: "/expose",
        internal_href: "/(main)/(tabs)/expose",
        screen: "expose",
    },
    MainTabRoute {
        id: "loops",
        href: "/loops",
        internal_href: "/(main)/(tabs)/loops",
        screen: "loops",
    },
    MainTabRoute {
        id: "topology",
        href: "/topology",
        internal_href: "/(main)/(tabs)/topology",
        screen: "topology",
    },
    MainTabRoute {
        id: "project",
        href: "/project",
        internal_href: "/(main)/(tabs)/project",
        screen: "project",
    },
    MainTabRoute {
        id: "library",
        href: "/library",
        internal_href: "/(main)/(tabs)/library",
        screen: "library",
    },
    MainTabRoute {
        id: "inbox",
        href: "/notifications",
        internal_href: "/(main)/(tabs)/notifications",
        screen: "notifications",
    },
    MainTabRoute {
        id: "threads",
        href: "/threads",
        internal_href: "/(main)/(tabs)/threads",
        screen: "threads",
    },
    MainTabRoute {
        id: "settings",
        href: "/settings",
        internal_href: "/(main)/(tabs)/(settings)/settings",
        screen: "(settings)",
    },
];

fn main_tab_route(tab_id: &str) -> MainTabRoute {
    MAIN_TAB_ROUTES
        .iter()
        .copied()
        .find(|route| route.id == tab_id)
        .unwrap_or(MAIN_TAB_ROUTES[0])
}
