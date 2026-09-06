use super::{
    ProjectServiceHttpMethod as Method, ProjectServiceRouteGroup as Group,
    ProjectServiceRouteSpec as Spec,
};

pub const ROUTES: &[Spec] = &[
    Spec::prefix(Method::Get, "/plans/", Group::Plans),
    Spec::prefix(Method::Put, "/plans/", Group::Plans),
];
