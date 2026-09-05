use crate::project_api_contract::routes;

use super::{
    ProjectServiceHttpMethod as Method, ProjectServiceRouteGroup as Group,
    ProjectServiceRouteSpec as Spec,
};

pub const ROUTES: &[Spec] = &[
    Spec::exact_sse(Method::Get, routes::EVENTS, Group::Events),
    Spec::exact_sse(Method::Get, routes::agents::OUTPUT_STREAM, Group::Events),
    Spec::exact_sse(
        Method::Get,
        routes::agents::INTERACTION_STREAM,
        Group::Events,
    ),
];
