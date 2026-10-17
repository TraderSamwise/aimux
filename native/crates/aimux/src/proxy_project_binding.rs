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
