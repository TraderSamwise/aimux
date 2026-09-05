use crate::project_api_contract::routes;

use super::{
    ProjectServiceHttpMethod as Method, ProjectServiceRouteGroup as Group,
    ProjectServiceRouteSpec as Spec,
};

pub const ROUTES: &[Spec] = &[
    Spec::exact(Method::Get, routes::PLANS, Group::Plans),
    Spec::prefix(Method::Get, "/plans/", Group::Plans),
    Spec::prefix(Method::Put, "/plans/", Group::Plans),
];
