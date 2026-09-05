use crate::project_api_contract;

pub mod agents;
pub mod collaboration;
pub mod controls;
pub mod events;
pub mod io;
pub mod lifecycle;
pub mod plans;
pub mod reads;
pub mod runtime;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ProjectServiceHttpMethod {
    Get,
    Post,
    Put,
    Delete,
}

impl ProjectServiceHttpMethod {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Delete => "DELETE",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ProjectServiceRouteGroup {
    Events,
    Reads,
    Controls,
    Runtime,
    Collaboration,
    Agents,
    Io,
    Lifecycle,
    Plans,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProjectServiceRoutePattern {
    Exact(&'static str),
    Prefix(&'static str),
    AttachmentMetadata,
    AttachmentContent,
}

impl ProjectServiceRoutePattern {
    pub const fn display_path(self) -> &'static str {
        match self {
            Self::Exact(path) | Self::Prefix(path) => path,
            Self::AttachmentMetadata => "/attachments/:id",
            Self::AttachmentContent => "/attachments/:id/content",
        }
    }

    pub const fn exact_path(self) -> Option<&'static str> {
        match self {
            Self::Exact(path) => Some(path),
            Self::Prefix(_) | Self::AttachmentMetadata | Self::AttachmentContent => None,
        }
    }

    pub fn matches(self, path: &str) -> bool {
        match self {
            Self::Exact(expected) => path == expected,
            Self::Prefix(prefix) => path.starts_with(prefix) && path.len() > prefix.len(),
            Self::AttachmentMetadata => path
                .strip_prefix("/attachments/")
                .is_some_and(|tail| !tail.is_empty() && !tail.contains('/')),
            Self::AttachmentContent => path
                .strip_prefix("/attachments/")
                .and_then(|tail| tail.strip_suffix("/content"))
                .is_some_and(|id| !id.is_empty() && !id.contains('/')),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProjectServiceResponseKind {
    Json,
    Sse,
    Binary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ProjectServiceRouteSpec {
    pub method: ProjectServiceHttpMethod,
    pub pattern: ProjectServiceRoutePattern,
    pub group: ProjectServiceRouteGroup,
    pub response: ProjectServiceResponseKind,
}

impl ProjectServiceRouteSpec {
    pub const fn exact(
        method: ProjectServiceHttpMethod,
        path: &'static str,
        group: ProjectServiceRouteGroup,
    ) -> Self {
        Self {
            method,
            pattern: ProjectServiceRoutePattern::Exact(path),
            group,
            response: ProjectServiceResponseKind::Json,
        }
    }

    pub const fn exact_sse(
        method: ProjectServiceHttpMethod,
        path: &'static str,
        group: ProjectServiceRouteGroup,
    ) -> Self {
        Self {
            method,
            pattern: ProjectServiceRoutePattern::Exact(path),
            group,
            response: ProjectServiceResponseKind::Sse,
        }
    }

    pub const fn exact_binary(
        method: ProjectServiceHttpMethod,
        path: &'static str,
        group: ProjectServiceRouteGroup,
    ) -> Self {
        Self {
            method,
            pattern: ProjectServiceRoutePattern::Exact(path),
            group,
            response: ProjectServiceResponseKind::Binary,
        }
    }

    pub const fn prefix(
        method: ProjectServiceHttpMethod,
        prefix: &'static str,
        group: ProjectServiceRouteGroup,
    ) -> Self {
        Self {
            method,
            pattern: ProjectServiceRoutePattern::Prefix(prefix),
            group,
            response: ProjectServiceResponseKind::Json,
        }
    }

    pub const fn prefix_binary(
        method: ProjectServiceHttpMethod,
        prefix: &'static str,
        group: ProjectServiceRouteGroup,
    ) -> Self {
        Self {
            method,
            pattern: ProjectServiceRoutePattern::Prefix(prefix),
            group,
            response: ProjectServiceResponseKind::Binary,
        }
    }

    pub const fn attachment_metadata(method: ProjectServiceHttpMethod) -> Self {
        Self {
            method,
            pattern: ProjectServiceRoutePattern::AttachmentMetadata,
            group: ProjectServiceRouteGroup::Io,
            response: ProjectServiceResponseKind::Json,
        }
    }

    pub const fn attachment_content(method: ProjectServiceHttpMethod) -> Self {
        Self {
            method,
            pattern: ProjectServiceRoutePattern::AttachmentContent,
            group: ProjectServiceRouteGroup::Io,
            response: ProjectServiceResponseKind::Binary,
        }
    }
}

pub fn project_service_route_specs() -> Vec<ProjectServiceRouteSpec> {
    let mut specs = Vec::new();
    specs.extend_from_slice(events::ROUTES);
    specs.extend_from_slice(reads::ROUTES);
    specs.extend_from_slice(controls::ROUTES);
    specs.extend_from_slice(runtime::ROUTES);
    specs.extend_from_slice(collaboration::ROUTES);
    specs.extend_from_slice(agents::ROUTES);
    specs.extend_from_slice(io::ROUTES);
    specs.extend_from_slice(lifecycle::ROUTES);
    specs.extend_from_slice(plans::ROUTES);
    specs
}

pub fn project_service_specs_for(
    method: ProjectServiceHttpMethod,
    path: &str,
) -> Vec<ProjectServiceRouteSpec> {
    project_service_route_specs()
        .into_iter()
        .filter(|spec| spec.method == method && spec.pattern.matches(path))
        .collect()
}

pub fn canonical_project_api_routes() -> Vec<&'static str> {
    project_api_contract::collect_project_api_routes()
}
