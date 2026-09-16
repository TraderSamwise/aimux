use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BuildInfo {
    pub package: &'static str,
    pub version: &'static str,
    pub profile: &'static str,
    pub variant: &'static str,
    pub zero_node_cli_target: bool,
}

pub fn build_info() -> BuildInfo {
    BuildInfo {
        package: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
        profile: embedded_package_profile(),
        variant: option_env!("AIMUX_BUILD_VARIANT").unwrap_or(
            if cfg!(feature = "remote-control") {
                "full"
            } else {
                "local"
            },
        ),
        zero_node_cli_target: true,
    }
}

fn embedded_package_profile() -> &'static str {
    if let Some(profile) = option_env!("AIMUX_PACKAGE_PROFILE") {
        return profile;
    }
    match option_env!("AIMUX_BUILD_PROFILE") {
        Some("local") => "minimal",
        Some(profile) => profile,
        None => "native-dev",
    }
}
