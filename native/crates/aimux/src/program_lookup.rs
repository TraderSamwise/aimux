//! Find an external binary once, by absolute path.
//!
//! A bare program name makes the OS walk `PATH` on every spawn, and on a
//! developer Mac that is routinely a dozen failed `exec`s before the hit --
//! paid again by every child, forever. AGENTS.md "Subprocess Churn" asks for
//! one resolution per process and an absolute path to the children; this is
//! the walk both `tmux` and `git` do it with.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The first executable file named `program` on `path_env`.
///
/// `current_dir` resolves a relative `PATH` entry, which is legal and rare.
/// The error names every candidate that was tried, because "not found" with
/// no list is the message that sends someone to check an install that is
/// fine.
pub fn resolve_program_from_path(
    program: &str,
    path_env: Option<OsString>,
    current_dir: Option<&Path>,
) -> Result<OsString, String> {
    let current_dir = current_dir
        .map(Path::to_path_buf)
        .or_else(|| std::env::current_dir().ok());
    let Some(path_env) = path_env.filter(|value| !value.is_empty()) else {
        return Err(format!("{program} executable not found: PATH is empty"));
    };
    let mut searched = Vec::new();
    for dir in std::env::split_paths(&path_env) {
        let candidate = candidate_path(program, &dir, current_dir.as_deref());
        searched.push(candidate.display().to_string());
        if executable_file_exists(&candidate) {
            return Ok(candidate.into_os_string());
        }
    }
    Err(format!(
        "{program} executable not found; searched {}",
        searched.join(", ")
    ))
}

fn candidate_path(program: &str, path_entry: &Path, current_dir: Option<&Path>) -> PathBuf {
    let dir = if path_entry.as_os_str().is_empty() {
        Path::new(".")
    } else {
        path_entry
    };
    let candidate = dir.join(program);
    if candidate.is_absolute() {
        return candidate;
    }
    current_dir
        .map(|cwd| cwd.join(&candidate))
        .unwrap_or(candidate)
}

pub fn executable_file_exists(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "aimux-program-lookup-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("lookup fixture root");
        root
    }

    /// A file of the right name that cannot be run is not the program.
    ///
    /// The `tmux` resolution tests only ever put an empty directory before
    /// the real one, so this -- `is_file` plus the executable bit -- was the
    /// half of the check nothing exercised.
    #[test]
    fn a_name_match_that_cannot_be_executed_is_skipped() {
        let root = root("not-executable");
        let shadow = root.join("shadow");
        let real = root.join("real");
        std::fs::create_dir_all(&shadow).expect("shadow dir");
        std::fs::create_dir_all(&real).expect("real dir");
        // Same name, not executable.
        std::fs::write(shadow.join("widget"), "#!/bin/sh\nexit 0\n").expect("write shadow");
        // And a directory of that name, which is also not the program.
        std::fs::create_dir_all(shadow.join("gadget")).expect("gadget dir");
        let chosen = real.join("widget");
        std::fs::write(&chosen, "#!/bin/sh\nexit 0\n").expect("write real");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&chosen, std::fs::Permissions::from_mode(0o755))
                .expect("make it executable");
        }

        let path_env = std::env::join_paths([shadow.as_os_str(), real.as_os_str()])
            .expect("join the search path");
        let found = resolve_program_from_path("widget", Some(path_env.clone()), None)
            .expect("the executable one is found");
        assert_eq!(found, chosen.into_os_string());

        let missing = resolve_program_from_path("gadget", Some(path_env), None)
            .expect_err("a directory of that name is not the program");
        assert!(
            missing.contains("gadget executable not found; searched"),
            "{missing}"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn an_empty_search_path_says_so_rather_than_listing_nothing() {
        let error = resolve_program_from_path("widget", None, None)
            .expect_err("nothing can be found without a PATH");
        assert_eq!(error, "widget executable not found: PATH is empty");
    }
}
