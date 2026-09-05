use crate::project_api_contract::routes;

use super::{
    ProjectServiceHttpMethod as Method, ProjectServiceRouteGroup as Group,
    ProjectServiceRouteSpec as Spec,
};

pub const ROUTES: &[Spec] = &[
    Spec::exact(Method::Post, routes::runtime::USAGE_MARK, Group::Runtime),
    Spec::exact(Method::Post, routes::runtime::SET_STATUS, Group::Runtime),
    Spec::exact(Method::Post, routes::runtime::SET_PROGRESS, Group::Runtime),
    Spec::exact(Method::Post, routes::runtime::SET_CONTEXT, Group::Runtime),
    Spec::exact(Method::Post, routes::runtime::SET_SERVICES, Group::Runtime),
    Spec::exact(Method::Post, routes::runtime::LOG, Group::Runtime),
    Spec::exact(Method::Post, routes::runtime::EVENT, Group::Runtime),
    Spec::exact(Method::Post, routes::runtime::MARK_SEEN, Group::Runtime),
    Spec::exact(Method::Post, routes::runtime::SET_ACTIVITY, Group::Runtime),
    Spec::exact(Method::Post, routes::runtime::SET_ATTENTION, Group::Runtime),
    Spec::exact(Method::Post, routes::runtime::CLEAR_LOG, Group::Runtime),
    Spec::exact(Method::Post, routes::runtime::NOTIFY, Group::Runtime),
    Spec::exact(
        Method::Post,
        routes::runtime::NOTIFICATION_CONTEXT,
        Group::Runtime,
    ),
    Spec::exact(Method::Post, routes::runtime::SHELL_STATE, Group::Runtime),
    Spec::exact(
        Method::Post,
        routes::runtime::COMPACT_EXCHANGE,
        Group::Runtime,
    ),
    Spec::exact(Method::Post, routes::hooks::CLAUDE, Group::Runtime),
    Spec::exact(Method::Post, routes::hooks::CODEX, Group::Runtime),
    Spec::exact(Method::Post, routes::STATUSLINE_REFRESH, Group::Runtime),
    Spec::exact(Method::Post, routes::STATUSLINE_SEGMENT, Group::Runtime),
    Spec::exact(Method::Delete, routes::STATUSLINE_SEGMENT, Group::Runtime),
    Spec::exact(
        Method::Post,
        routes::OPERATION_FAILURES_CLEAR,
        Group::Runtime,
    ),
];
