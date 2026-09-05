use crate::project_api_contract::routes;

use super::{
    ProjectServiceHttpMethod as Method, ProjectServiceRouteGroup as Group,
    ProjectServiceRouteSpec as Spec,
};

pub const ROUTES: &[Spec] = &[
    Spec::exact(Method::Get, routes::HEALTH, Group::Reads),
    Spec::exact(Method::Get, routes::DIAGNOSTICS, Group::Reads),
    Spec::exact(Method::Get, routes::DIAGNOSTICS_LIFECYCLE, Group::Reads),
    Spec::exact(Method::Get, routes::STATE, Group::Reads),
    Spec::exact(Method::Get, routes::DESKTOP_STATE, Group::Reads),
    Spec::exact(Method::Get, routes::COORDINATION_WORKLIST, Group::Reads),
    Spec::exact(Method::Get, routes::PROJECT_OBSERVABILITY, Group::Reads),
    Spec::exact(Method::Get, routes::TOPOLOGY, Group::Reads),
    Spec::exact(Method::Get, routes::LIBRARY, Group::Reads),
    Spec::exact(Method::Get, routes::WORKTREES, Group::Reads),
    Spec::exact(Method::Get, routes::GRAVEYARD, Group::Reads),
    Spec::exact(Method::Get, routes::work_outline::LIST, Group::Reads),
    Spec::exact(Method::Get, routes::notifications::LIST, Group::Reads),
    Spec::exact(Method::Get, routes::orchestration::ROUTES, Group::Reads),
    Spec::exact(Method::Get, routes::agents::LIST, Group::Reads),
    Spec::exact(Method::Get, routes::agents::TEAMMATES, Group::Reads),
    Spec::exact(Method::Get, routes::agents::HISTORY, Group::Reads),
    Spec::exact(Method::Get, routes::threads::LIST, Group::Reads),
    Spec::prefix(Method::Get, "/threads/", Group::Reads),
    Spec::exact(Method::Get, routes::tasks::LIST, Group::Reads),
    Spec::prefix(Method::Get, "/tasks/", Group::Reads),
    Spec::exact(Method::Get, routes::team::CONFIG, Group::Reads),
    Spec::exact(
        Method::Get,
        routes::controls::SWITCHABLE_AGENTS,
        Group::Reads,
    ),
];
