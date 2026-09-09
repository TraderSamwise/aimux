pub fn is_aimux_build_drift_error(error_message: Option<&str>, is_error: bool) -> bool {
    is_error && error_message.is_some_and(|message| message.contains("different local build"))
}
