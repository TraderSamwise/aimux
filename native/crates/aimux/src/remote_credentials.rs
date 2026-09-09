use crate::atomic_write::atomic_write_with_mode;
use crate::paths::PathResolver;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AimuxCredentials {
    pub version: u8,
    pub relay_url: String,
    pub token: String,
    pub user_id: String,
    pub created_at: String,
    pub remote_enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClearCredentialsResult {
    Cleared,
    None,
    Failed,
}

impl ClearCredentialsResult {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Cleared => "cleared",
            Self::None => "none",
            Self::Failed => "failed",
        }
    }
}

pub fn load_credentials(resolver: &PathResolver) -> Option<AimuxCredentials> {
    load_credentials_at(resolver.auth_path())
}

pub fn load_credentials_at(path: impl AsRef<Path>) -> Option<AimuxCredentials> {
    let parsed: AimuxCredentials = serde_json::from_slice(&fs::read(path.as_ref()).ok()?).ok()?;
    (parsed.version == 1 && !parsed.token.is_empty() && !parsed.relay_url.is_empty())
        .then_some(parsed)
}

pub fn save_credentials_at(
    path: impl AsRef<Path>,
    credentials: &AimuxCredentials,
) -> io::Result<()> {
    let mut data = serde_json::to_string_pretty(credentials).map_err(io::Error::other)?;
    data.push('\n');
    atomic_write_with_mode(path, data, Some(0o600))
}

pub fn clear_credentials(resolver: &PathResolver) -> ClearCredentialsResult {
    clear_credentials_at(resolver.auth_path())
}

pub fn clear_credentials_at(path: impl AsRef<Path>) -> ClearCredentialsResult {
    let path = path.as_ref();
    if !path.exists() {
        return ClearCredentialsResult::None;
    }
    match fs::remove_file(path) {
        Ok(()) => ClearCredentialsResult::Cleared,
        Err(_) => ClearCredentialsResult::Failed,
    }
}

pub fn set_remote_enabled(
    resolver: &PathResolver,
    enabled: bool,
) -> io::Result<Option<AimuxCredentials>> {
    set_remote_enabled_at(resolver.auth_path(), enabled)
}

pub fn set_remote_enabled_at(
    path: impl AsRef<Path>,
    enabled: bool,
) -> io::Result<Option<AimuxCredentials>> {
    let path = path.as_ref();
    let Some(mut credentials) = load_credentials_at(path) else {
        return Ok(None);
    };
    credentials.remote_enabled = enabled;
    save_credentials_at(path, &credentials)?;
    Ok(Some(credentials))
}
