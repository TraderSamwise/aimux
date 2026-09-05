use crate::project_api_contract::routes;

use super::{
    ProjectServiceHttpMethod as Method, ProjectServiceRouteGroup as Group,
    ProjectServiceRouteSpec as Spec,
};

pub const ROUTES: &[Spec] = &[
    Spec::exact(
        Method::Post,
        routes::notifications::READ,
        Group::Collaboration,
    ),
    Spec::exact(
        Method::Post,
        routes::notifications::CLEAR,
        Group::Collaboration,
    ),
    Spec::exact(Method::Post, routes::threads::OPEN, Group::Collaboration),
    Spec::exact(Method::Post, routes::threads::SEND, Group::Collaboration),
    Spec::exact(
        Method::Post,
        routes::threads::MARK_SEEN,
        Group::Collaboration,
    ),
    Spec::exact(Method::Post, routes::threads::STATUS, Group::Collaboration),
    Spec::exact(Method::Post, routes::tasks::ASSIGN, Group::Collaboration),
    Spec::exact(Method::Post, routes::tasks::ACCEPT, Group::Collaboration),
    Spec::exact(Method::Post, routes::tasks::BLOCK, Group::Collaboration),
    Spec::exact(Method::Post, routes::tasks::COMPLETE, Group::Collaboration),
    Spec::exact(Method::Post, routes::tasks::REOPEN, Group::Collaboration),
    Spec::exact(Method::Post, routes::handoff::SEND, Group::Collaboration),
    Spec::exact(Method::Post, routes::handoff::ACCEPT, Group::Collaboration),
    Spec::exact(
        Method::Post,
        routes::handoff::COMPLETE,
        Group::Collaboration,
    ),
    Spec::exact(Method::Post, routes::reviews::APPROVE, Group::Collaboration),
    Spec::exact(
        Method::Post,
        routes::reviews::REQUEST_CHANGES,
        Group::Collaboration,
    ),
    Spec::exact(
        Method::Post,
        routes::agents::INTERACTION_REGISTER,
        Group::Collaboration,
    ),
    Spec::exact(
        Method::Post,
        routes::agents::INTERACTION_NOTIFY,
        Group::Collaboration,
    ),
    Spec::exact(
        Method::Post,
        routes::agents::INTERACTION_REQUEST,
        Group::Collaboration,
    ),
    Spec::exact(
        Method::Get,
        routes::agents::INTERACTION_WAIT,
        Group::Collaboration,
    ),
    Spec::exact(
        Method::Post,
        routes::agents::INTERACTION_RESPOND,
        Group::Collaboration,
    ),
    Spec::exact(
        Method::Get,
        routes::agents::INTERACTION_PENDING,
        Group::Collaboration,
    ),
];
