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

/// The cap the relay truncates a stored project root to, and which this has
/// to share for the fold below to agree with it.
///
/// Defined in two languages, which is a thing that drifts: the other copy is
/// `MAX_PROJECT_ROOT_CHARS` in `relay/src/sharing.ts`. Changing one without
/// the other does not fail anything loudly -- it makes long checkout paths
/// unmatchable between the owner record and this lookup, which surfaces as
/// "this machine is not serving" a project it is serving.
const MAX_PROJECT_ROOT_CHARS: usize = 600;

/// The relay's own key, in the relay's own order.
///
/// Not character for character, and the difference is written down rather than
/// claimed away: the cap is counted in Unicode scalars here and in UTF-16
/// units by the relay's `slice`, and the two trims disagree at the edges (Rust
/// trims U+0085, JavaScript trims U+FEFF -- the same divergence
/// `shared_chat_trim` exists for). A checkout path long enough to reach the cap
/// AND carrying an astral character would key differently on the two sides.
/// That is reachable only past six hundred characters with an emoji in the
/// path, and the honest thing is to say so here rather than to claim an
/// equality that does not hold.
///
/// `shareProjectRootKey` is `trim`, then truncate to the cap, then strip EVERY
/// trailing slash, falling back to the truncated value if that empties it.
/// Three details, and the first version of this got two of them wrong: it
/// stripped one slash instead of all of them, and it never truncated. So
/// `/repo//` keyed as `/repo` at the relay and `/repo/` here, and a root past
/// six hundred characters keyed as its prefix there and whole here -- a lookup
/// that misses the project the owner record names, reported as "this machine
/// is not serving" a project it is serving.
///
/// The ORDER matters and is the relay's: truncate, THEN fold. The other way
/// round makes a root whose six-hundredth character is a slash unmatchable,
/// which is written down beside the relay's own copy for the same reason.
/// The relay's key, for callers outside this module.
///
/// Exported rather than copied, because the owner table is keyed by the relay
/// and looked up by the daemon: two folds would be two keys, and a daemon
/// would decide a checkout is unowned because it folded the name differently
/// from the record naming it.
pub fn fold_project_root_for_lookup(raw: &str) -> &str {
    fold_project_root(raw)
}

fn fold_project_root(raw: &str) -> &str {
    let trimmed = raw.trim();
    let stored = match trimmed.char_indices().nth(MAX_PROJECT_ROOT_CHARS) {
        Some((offset, _)) => &trimmed[..offset],
        None => trimmed,
    };
    let folded = stored.trim_end_matches('/');
    // `|| stored` in the relay: a root that is nothing but slashes keeps them
    // rather than becoming the empty key, which would match every other such
    // root.
    if folded.is_empty() { stored } else { folded }
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
