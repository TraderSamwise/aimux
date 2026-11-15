use crate::daemon_projects::ProjectsRouteProject;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyTarget {
    pub host: String,
    pub port: u64,
    pub sub_path: String,
}

pub fn parse_proxy_target(pathname: &str) -> Option<ProxyTarget> {
    let rest = pathname.strip_prefix("/proxy/")?;
    let host_end = rest.find('/')?;
    let host = &rest[..host_end];
    if host.is_empty() {
        return None;
    }
    let rest = &rest[host_end + 1..];
    let port_end = rest.find('/')?;
    let port_text = &rest[..port_end];
    if port_text.is_empty() || !port_text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let port = port_text.parse::<u64>().ok()?;
    if port == 0 {
        return None;
    }
    Some(ProxyTarget {
        host: host.to_owned(),
        port,
        sub_path: format!("/{}", &rest[port_end + 1..]),
    })
}

pub fn resolve_project_root_for_service_target(
    candidates: &[ProjectsRouteProject],
    target: Option<&ProxyTarget>,
) -> Option<String> {
    let target = target?;
    if target.host.is_empty() || target.port == 0 {
        return None;
    }

    let mut matches = candidates.iter().filter(|candidate| {
        candidate.service_alive
            && !candidate.path.is_empty()
            && endpoint_host(candidate.service_endpoint.as_ref()) == Some(target.host.as_str())
            && endpoint_port(candidate.service_endpoint.as_ref()) == Some(target.port)
    });
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(first.path.clone())
}

/// The one route a peer machine reaches by NAMING A PROJECT rather than a port.
///
/// Deliberately outside `/core/`: those are the CLI's own routes and the
/// router refuses every one of them to a caller carrying an actor. This is the
/// opposite audience, so it says so in the path.
pub const PEER_AGENT_INPUT_ROUTE: &str = "/peer/agents/input";

/// Which of this daemon's projects a caller named, and where its service is.
///
/// The same slice `resolve_project_root_for_service_target` reads, asked the
/// other way round: by project path instead of by host and port. That is the
/// whole difference between the two peer doors -- on the proxy route the peer
/// supplies the port and this daemon checks it, here the peer supplies the
/// project and this daemon supplies the port. The second is the stronger of
/// the two, because the address stops coming from the caller.
///
/// `service_alive` and a real endpoint are both required, so a project this
/// daemon knows about but is not currently serving resolves to nothing rather
/// than to an address that answers for somebody else.
pub fn resolve_service_target_for_project_root(
    candidates: &[ProjectsRouteProject],
    project_root: &str,
) -> Option<ProxyTarget> {
    let wanted = fold_project_root(project_root);
    if wanted.is_empty() {
        return None;
    }
    let mut matches = candidates.iter().filter(|candidate| {
        candidate.service_alive && fold_project_root(&candidate.path) == wanted
    });
    let first = matches.next()?;
    // Two projects at one path is not a thing this can pick between, and
    // guessing would aim a peer's keystrokes at whichever came back first.
    if matches.next().is_some() {
        return None;
    }
    let host = endpoint_host(first.service_endpoint.as_ref())?;
    let port = endpoint_port(first.service_endpoint.as_ref())?;
    if host.is_empty() || port == 0 {
        return None;
    }
    Some(ProxyTarget {
        host: host.to_owned(),
        port,
        sub_path: String::new(),
    })
}

/// A trailing slash and nothing else, matching the relay's own key.
///
/// The relay folds exactly this much when it keys a checkout
/// (`shareProjectRootKey`), so a lookup here has to fold the same amount or
/// the two disagree about whether `/repo` and `/repo/` are one checkout.
fn fold_project_root(raw: &str) -> &str {
    let trimmed = raw.trim();
    if trimmed.len() > 1 {
        trimmed.strip_suffix('/').unwrap_or(trimmed)
    } else {
        trimmed
    }
}

pub fn is_binary_project_route(sub_path: &str) -> bool {
    let Some(rest) = sub_path.strip_prefix("/attachments/") else {
        return false;
    };
    let Some(id) = rest.strip_suffix("/content") else {
        return false;
    };
    !id.is_empty() && !id.contains('/')
}

fn endpoint_host(endpoint: Option<&Value>) -> Option<&str> {
    endpoint?.get("host").and_then(Value::as_str)
}

fn endpoint_port(endpoint: Option<&Value>) -> Option<u64> {
    let value = endpoint?.get("port")?;
    if let Some(port) = value.as_u64() {
        return Some(port);
    }
    let number = value.as_f64()?;
    if number.is_finite() && number.fract() == 0.0 && number > 0.0 {
        Some(number as u64)
    } else {
        None
    }
}
