use crate::project_api_contract::routes;

use super::{
    ProjectServiceHttpMethod as Method, ProjectServiceRouteGroup as Group,
    ProjectServiceRouteSpec as Spec,
};

pub const ROUTES: &[Spec] = &[
    Spec::exact(Method::Post, routes::agents::SPAWN, Group::Lifecycle),
    Spec::exact(Method::Post, routes::agents::FORK, Group::Lifecycle),
    Spec::exact(Method::Post, routes::agents::SWITCH_TOOL, Group::Lifecycle),
    Spec::exact(Method::Post, routes::agents::STOP, Group::Lifecycle),
    Spec::exact(Method::Post, routes::agents::RESUME, Group::Lifecycle),
    Spec::exact(
        Method::Post,
        routes::agents::RESTORE_PREVIOUS,
        Group::Lifecycle,
    ),
    Spec::exact(
        Method::Post,
        routes::agents::DISMISS_RESTORE_PREVIOUS,
        Group::Lifecycle,
    ),
    Spec::exact(Method::Post, routes::agents::KILL, Group::Lifecycle),
    Spec::exact(Method::Post, routes::agents::INTERRUPT, Group::Lifecycle),
    Spec::exact(Method::Post, routes::agents::RENAME, Group::Lifecycle),
    Spec::exact(Method::Post, routes::agents::MIGRATE, Group::Lifecycle),
    Spec::exact(
        Method::Post,
        routes::agents::RECORD_BACKEND_SESSION,
        Group::Lifecycle,
    ),
    Spec::exact(
        Method::Post,
        routes::agents::CREATE_TEAMMATE,
        Group::Lifecycle,
    ),
    Spec::exact(
        Method::Post,
        routes::agents::STOP_TEAMMATE,
        Group::Lifecycle,
    ),
    Spec::exact(
        Method::Post,
        routes::agents::RESUME_TEAMMATE,
        Group::Lifecycle,
    ),
    Spec::exact(
        Method::Post,
        routes::agents::KILL_TEAMMATE,
        Group::Lifecycle,
    ),
    Spec::exact(
        Method::Post,
        routes::agents::RESURRECT_TEAMMATE,
        Group::Lifecycle,
    ),
    Spec::exact(
        Method::Post,
        routes::worktree_actions::CREATE,
        Group::Lifecycle,
    ),
    Spec::exact(
        Method::Post,
        routes::worktree_actions::CACHE_CLEANUP,
        Group::Lifecycle,
    ),
    Spec::exact(
        Method::Post,
        routes::worktree_actions::REMOVE,
        Group::Lifecycle,
    ),
    Spec::exact(
        Method::Post,
        routes::worktree_actions::GRAVEYARD,
        Group::Lifecycle,
    ),
    Spec::exact(Method::Post, routes::services::CREATE, Group::Lifecycle),
    Spec::exact(Method::Post, routes::services::STOP, Group::Lifecycle),
    Spec::exact(Method::Post, routes::services::RESUME, Group::Lifecycle),
    Spec::exact(Method::Post, routes::services::REMOVE, Group::Lifecycle),
    Spec::exact(
        Method::Post,
        routes::graveyard_actions::RESURRECT_AGENT,
        Group::Lifecycle,
    ),
    Spec::exact(
        Method::Post,
        routes::graveyard_actions::RESURRECT_WORKTREE,
        Group::Lifecycle,
    ),
    Spec::exact(
        Method::Post,
        routes::graveyard_actions::DELETE_WORKTREE,
        Group::Lifecycle,
    ),
    Spec::exact(
        Method::Post,
        routes::graveyard_actions::CLEANUP,
        Group::Lifecycle,
    ),
];
