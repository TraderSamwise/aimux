use serde_json::Value;

pub fn supports_exact_backend_resume(tool_config: Option<&Value>) -> bool {
    let Some(tool_config) = tool_config else {
        return false;
    };
    let has_session_placeholder = tool_config
        .get("resumeArgs")
        .and_then(Value::as_array)
        .is_some_and(|args| {
            args.iter()
                .any(|arg| arg.as_str().is_some_and(|arg| arg.contains("{sessionId}")))
        });
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
    exact_backend_resume_blocked_reason(tool_key, tool_config)
        .map(|reason| format!("{reason}; this session cannot be restored after an Aimux restart"))
}
