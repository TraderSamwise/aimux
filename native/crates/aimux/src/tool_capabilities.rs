use crate::backend_session_ids::backend_session_id_is_discoverable;
use serde_json::Value;

/// Does this arg list carry a `{sessionId}` placeholder?
///
/// `config::has_session_placeholder` answers the same question but panics on
/// a value that is neither an array nor null, to match a Node-era parity
/// case. A capability predicate is asked about whatever a user put in their
/// config, so it answers "no" there instead of bringing the process down.
fn declares_session_id_placeholder(value: Option<&Value>) -> bool {
    value.and_then(Value::as_array).is_some_and(|args| {
        args.iter()
            .any(|arg| arg.as_str().is_some_and(|arg| arg.contains("{sessionId}")))
    })
}

pub fn supports_exact_backend_resume(tool_config: Option<&Value>) -> bool {
    let Some(tool_config) = tool_config else {
        return false;
    };
    let has_session_placeholder = declares_session_id_placeholder(tool_config.get("resumeArgs"));
    has_session_placeholder
        && tool_config
            .get("resumeByBackendSessionId")
            .and_then(Value::as_bool)
            != Some(false)
}

pub fn exact_backend_resume_blocked_reason(
    tool_key: &str,
    tool_config: Option<&Value>,
) -> Option<String> {
    (!supports_exact_backend_resume(tool_config))
        .then(|| format!("agent tool \"{tool_key}\" does not support exact backend resume"))
}

pub fn restart_restore_warning(tool_key: &str, tool_config: Option<&Value>) -> Option<String> {
    // Two broken states, and the second one was silent: a tool that cannot
    // resume at all says so, and a tool that claims it can while nothing can
    // acquire its id now says that instead of saying nothing.
    exact_backend_resume_blocked_reason(tool_key, tool_config)
        .or_else(|| exact_backend_resume_unacquirable_reason(tool_key, tool_config))
        .map(|reason| format!("{reason}; this session cannot be restored after an Aimux restart"))
}

/// Can aimux ever learn this tool's conversation id?
///
/// Two ways exist and there is no third: the tool is TOLD its id at launch
/// through `sessionIdFlag`, or aimux FINDS it afterwards by reading that
/// tool's own store. Claude has both, codex only the second.
pub fn has_backend_session_id_acquisition_path(
    tool_config_key: Option<&str>,
    tool_config: Option<&Value>,
) -> bool {
    declares_session_id_placeholder(tool_config.and_then(|config| config.get("sessionIdFlag")))
        || backend_session_id_is_discoverable(tool_config_key)
}

/// A tool that CLAIMS exact resume while nothing can acquire its id.
///
/// This is the shape that made every codex session block every control-plane
/// restart: the guard held the restart open waiting for a `backendSessionId`
/// that no part of the system could ever write. Declaring the capability is
/// not the same as having it, and the difference is only visible here.
pub fn exact_backend_resume_unacquirable_reason(
    tool_key: &str,
    tool_config: Option<&Value>,
) -> Option<String> {
    (supports_exact_backend_resume(tool_config)
        && !has_backend_session_id_acquisition_path(Some(tool_key), tool_config))
    .then(|| {
        format!(
            "agent tool \"{tool_key}\" is declared exact-resume but nothing can acquire its \
             conversation id: no sessionIdFlag to be told one at launch, and no discovery arm \
             to be found one afterwards"
        )
    })
}
