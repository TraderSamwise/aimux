use crate::project_api_contract::routes;

use super::{
    ProjectServiceHttpMethod as Method, ProjectServiceRouteGroup as Group,
    ProjectServiceRouteSpec as Spec,
};

pub const ROUTES: &[Spec] = &[
    Spec::exact(Method::Get, routes::agents::OUTPUT, Group::Io),
    Spec::exact(Method::Get, routes::live_pane::OUTPUT, Group::Io),
    Spec::exact(Method::Post, routes::agents::INPUT, Group::Io),
    Spec::exact(Method::Post, routes::live_pane::INPUT, Group::Io),
    Spec::exact(Method::Post, routes::live_pane::ATTACH, Group::Io),
    Spec::exact(Method::Post, routes::live_pane::INTERRUPT, Group::Io),
    Spec::exact(Method::Post, routes::live_pane::RESIZE, Group::Io),
    Spec::exact(Method::Post, routes::ATTACHMENTS, Group::Io),
    Spec::exact(Method::Post, routes::ATTACHMENTS_PUBLISH, Group::Io),
    Spec::attachment_metadata(Method::Get),
    Spec::attachment_content(Method::Get),
];
