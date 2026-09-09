use crate::project_api_contract::routes;

use super::{
    ProjectServiceHttpMethod as Method, ProjectServiceRouteGroup as Group,
    ProjectServiceRouteSpec as Spec,
};

pub const ROUTES: &[Spec] = &[
    Spec::exact(Method::Post, routes::team::INIT, Group::Agents),
    Spec::exact(Method::Post, routes::team::ADD_ROLE, Group::Agents),
    Spec::exact(Method::Post, routes::team::REMOVE_ROLE, Group::Agents),
    Spec::exact(Method::Post, routes::team::DEFAULT_ROLE, Group::Agents),
    Spec::exact(
        Method::Post,
        routes::agents::CREATE_TEAMMATE_TASK,
        Group::Agents,
    ),
    Spec::exact(
        Method::Post,
        routes::agents::RAW_TEAMMATE_SEND,
        Group::Agents,
    ),
    Spec::exact(Method::Post, routes::agents::PROMPT_CONTEXT, Group::Agents),
    Spec::exact(Method::Post, routes::agents::LOOP, Group::Agents),
    Spec::exact(Method::Post, routes::agents::OVERSEER, Group::Agents),
    Spec::exact(Method::Post, routes::agents::SCRIBE, Group::Agents),
    Spec::exact(Method::Post, routes::work_outline::UPDATE, Group::Agents),
];
