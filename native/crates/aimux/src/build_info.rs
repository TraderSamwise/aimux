use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BuildInfo {
    pub package: &'static str,
    pub version: &'static str,
    pub profile: &'static str,
    pub zero_node_cli_target: bool,
}

pub fn build_info() -> BuildInfo {
    BuildInfo {
        package: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
        profile: option_env!("AIMUX_BUILD_PROFILE").unwrap_or("native-dev"),
        zero_node_cli_target: true,
    }
}
