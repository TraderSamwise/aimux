use crate::project_api_contract::routes;

use super::{
    ProjectServiceHttpMethod as Method, ProjectServiceRouteGroup as Group,
    ProjectServiceRouteSpec as Spec,
};

pub const ROUTES: &[Spec] = &[
    Spec::exact(
        Method::Get,
        routes::controls::OPEN_DASHBOARD,
        Group::Controls,
    ),
    Spec::exact(
        Method::Post,
        routes::controls::OPEN_DASHBOARD,
        Group::Controls,
    ),
    Spec::exact(
        Method::Get,
        routes::controls::OPEN_NOTIFICATION_TARGET,
        Group::Controls,
    ),
    Spec::exact(
        Method::Post,
        routes::controls::OPEN_NOTIFICATION_TARGET,
        Group::Controls,
    ),
    Spec::exact(Method::Get, routes::controls::FOCUS_WINDOW, Group::Controls),
    Spec::exact(
        Method::Post,
        routes::controls::FOCUS_WINDOW,
        Group::Controls,
    ),
    Spec::exact(
        Method::Get,
        routes::controls::ACTIVE_WINDOW,
        Group::Controls,
    ),
    Spec::exact(
        Method::Post,
        routes::controls::ACTIVE_WINDOW,
        Group::Controls,
    ),
    Spec::exact(Method::Get, routes::controls::SWITCH_NEXT, Group::Controls),
    Spec::exact(Method::Post, routes::controls::SWITCH_NEXT, Group::Controls),
    Spec::exact(Method::Get, routes::controls::SWITCH_PREV, Group::Controls),
    Spec::exact(Method::Post, routes::controls::SWITCH_PREV, Group::Controls),
    Spec::exact(
        Method::Get,
        routes::controls::SWITCH_ATTENTION,
        Group::Controls,
    ),
    Spec::exact(
        Method::Post,
        routes::controls::SWITCH_ATTENTION,
        Group::Controls,
    ),
];
