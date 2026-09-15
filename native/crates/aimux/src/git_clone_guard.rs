use std::env;
use std::ffi::OsString;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use crate::atomic_write::atomic_write;

const GUARD_DIR_NAME: &str = "git-guard";

pub fn prepare_git_clone_guard_env(
    project_state_dir: impl AsRef<Path>,
    project_root: &str,
) -> Result<Vec<(String, String)>, String> {
    let project_state_dir = project_state_dir.as_ref();
    let guard_dir = project_state_dir.join(GUARD_DIR_NAME);
    fs::create_dir_all(&guard_dir).map_err(|error| {
        format!(
            "create git clone guard dir {} failed: {error}",
            path_string(&guard_dir)
        )
    })?;
    let guard_path = guard_dir.join("git");
    let real_git = find_real_git(&guard_dir).ok_or_else(|| {
        "install git clone guard failed: could not resolve real git on PATH".to_owned()
    })?;
    atomic_write(&guard_path, build_git_clone_guard_script()).map_err(|error| {
        format!(
            "write git clone guard {} failed: {error}",
            path_string(&guard_path)
        )
    })?;
    #[cfg(unix)]
    fs::set_permissions(&guard_path, fs::Permissions::from_mode(0o755)).map_err(|error| {
        format!(
            "mark git clone guard executable {} failed: {error}",
            path_string(&guard_path)
        )
    })?;
    let base_path = env::var("PATH").unwrap_or_default();
    let guard_dir = path_string(&guard_dir);
    let guarded_path = if base_path.is_empty() {
        guard_dir.clone()
    } else {
        format!("{guard_dir}:{base_path}")
    };
    Ok(vec![
        ("PATH".to_owned(), guarded_path),
        ("AIMUX_GIT_GUARD_REAL_GIT".to_owned(), path_string(real_git)),
        (
            "AIMUX_GIT_GUARD_PROJECT_ROOT".to_owned(),
            project_root.to_owned(),
        ),
    ])
}

fn find_real_git(guard_dir: &Path) -> Option<PathBuf> {
    find_real_git_from(
        guard_dir,
        env::var_os("PATH"),
        env::var_os("AIMUX_GIT_GUARD_REAL_GIT"),
    )
}

fn find_real_git_from(
    guard_dir: &Path,
    path_env: Option<OsString>,
    existing_real_git: Option<OsString>,
) -> Option<PathBuf> {
    if let Some(existing) = existing_real_git
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Some(existing);
    }
    let guard_dir = canonical_or_self(guard_dir);
    path_env
        .into_iter()
        .flat_map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .filter(|path| {
            let canonical = canonical_or_self(path);
            canonical != guard_dir
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_none_or(|name| name != GUARD_DIR_NAME)
        })
        .map(|path| path.join("git"))
        .find(|path| path.is_file())
}

fn canonical_or_self(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn path_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().into_owned()
}

fn build_git_clone_guard_script() -> &'static str {
    r#"#!/usr/bin/env sh
real_git="${AIMUX_GIT_GUARD_REAL_GIT:-git}"
project="${AIMUX_GIT_GUARD_PROJECT_ROOT:-${AIMUX_PROJECT_ROOT:-}}"

git_url_key() {
  printf '%s' "$1" | sed -e 's#/*$##' -e 's#\.git$##'
}

same_project_source() {
  source_value="$1"
  [ -n "$project" ] || return 1
  canonical_project="$(cd "$project" 2>/dev/null && pwd -P)" || return 1
  if canonical_source="$(cd "$source_value" 2>/dev/null && pwd -P)"; then
    [ "$canonical_source" = "$canonical_project" ] && return 0
  fi
  origin="$("$real_git" -C "$canonical_project" remote get-url origin 2>/dev/null || true)"
  [ -n "$origin" ] || return 1
  [ "$(git_url_key "$source_value")" = "$(git_url_key "$origin")" ]
}

git_command=""
skip_next=0
for arg in "$@"; do
  if [ "$skip_next" = "1" ]; then
    skip_next=0
    continue
  fi
  case "$arg" in
    -C|-c|--git-dir|--work-tree|--namespace|--exec-path)
      skip_next=1
      continue
      ;;
    --git-dir=*|--work-tree=*|--namespace=*|--exec-path=*)
      continue
      ;;
    --)
      continue
      ;;
    -*)
      continue
      ;;
    *)
      git_command="$arg"
      break
      ;;
  esac
done

if [ "$git_command" = "clone" ]; then
  seen_clone=0
  clone_source=""
  skip_next=0
  for arg in "$@"; do
    if [ "$seen_clone" = "0" ]; then
      [ "$arg" = "clone" ] && seen_clone=1
      continue
    fi
    if [ "$skip_next" = "1" ]; then
      skip_next=0
      continue
    fi
    case "$arg" in
      -b|--branch|--depth|--origin|--upload-pack|--template|--reference|--reference-if-able|--separate-git-dir|--jobs|--server-option|--filter)
        skip_next=1
        continue
        ;;
      --branch=*|--depth=*|--origin=*|--upload-pack=*|--template=*|--reference=*|--reference-if-able=*|--separate-git-dir=*|--jobs=*|--server-option=*|--filter=*)
        continue
        ;;
      --bare|--mirror|--recursive|--recurse-submodules|--no-checkout|--single-branch|--no-single-branch|--shallow-submodules|--remote-submodules|--also-filter-submodules)
        continue
        ;;
      --)
        continue
        ;;
      -*)
        continue
        ;;
      *)
        clone_source="$arg"
        break
        ;;
    esac
  done
  if [ -n "$clone_source" ] && same_project_source "$clone_source"; then
    printf '%s\n' "aimux: standalone git clone of this project is blocked inside Aimux agent sessions." >&2
    printf '%s\n' "Use: aimux worktree create <name> --project \"${project}\"" >&2
    printf '%s\n' "Linked worktrees share Sam's object store; standalone clone commits are stranded." >&2
    exit 2
  fi
fi

exec "$real_git" "$@"
"#
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let path = env::temp_dir().join(format!(
                "{label}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("time")
                    .as_nanos()
            ));
            fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn guard_blocks_clone_of_current_project_path_before_real_git() {
        let temp = TempDir::new("aimux-git-clone-guard-path");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        let guard = write_test_guard(temp.path());
        let fake_git = write_fake_git(temp.path());
        let output = Command::new(&guard)
            .args(["clone", project.to_str().expect("utf8 project"), "copy"])
            .env("AIMUX_GIT_GUARD_PROJECT_ROOT", &project)
            .env("AIMUX_GIT_GUARD_REAL_GIT", &fake_git)
            .output()
            .expect("run guard");

        assert_eq!(output.status.code(), Some(2));
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("standalone git clone of this project is blocked"));
        assert!(stderr.contains("aimux worktree create <name>"));
        assert!(!temp.path().join("fake-git.log").exists());
    }

    #[test]
    fn guard_blocks_clone_of_current_project_origin_url() {
        let temp = TempDir::new("aimux-git-clone-guard-origin");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        run_git(&project, &["init"]);
        run_git(
            &project,
            &["remote", "add", "origin", "git@example.com:sam/aimux.git"],
        );
        let guard = write_test_guard(temp.path());
        let output = Command::new(&guard)
            .args(["clone", "git@example.com:sam/aimux.git", "copy"])
            .env("AIMUX_GIT_GUARD_PROJECT_ROOT", &project)
            .env("AIMUX_GIT_GUARD_REAL_GIT", "git")
            .output()
            .expect("run guard");

        assert_eq!(output.status.code(), Some(2));
    }

    #[test]
    fn guard_allows_external_clone_and_non_clone_git() {
        let temp = TempDir::new("aimux-git-clone-guard-pass");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        let guard = write_test_guard(temp.path());
        let fake_git = write_fake_git(temp.path());

        let external = Command::new(&guard)
            .args(["clone", "https://example.com/other/repo.git", "copy"])
            .env("AIMUX_GIT_GUARD_PROJECT_ROOT", &project)
            .env("AIMUX_GIT_GUARD_REAL_GIT", &fake_git)
            .output()
            .expect("run guard");
        assert!(external.status.success());

        let status = Command::new(&guard)
            .args(["status", "--short"])
            .env("AIMUX_GIT_GUARD_PROJECT_ROOT", &project)
            .env("AIMUX_GIT_GUARD_REAL_GIT", &fake_git)
            .output()
            .expect("run guard");
        assert!(status.status.success());

        let log = fs::read_to_string(temp.path().join("fake-git.log")).expect("fake log");
        assert!(log.contains("clone https://example.com/other/repo.git copy"));
        assert!(log.contains("status --short"));
    }

    #[test]
    fn prepare_env_reuses_existing_real_git_instead_of_wrapping_a_guard() {
        let temp = TempDir::new("aimux-git-clone-guard-nested");
        let guard_dir = temp.path().join("state").join(GUARD_DIR_NAME);
        let parent_guard_dir = temp.path().join(GUARD_DIR_NAME);
        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&guard_dir).expect("state guard dir");
        fs::create_dir_all(&parent_guard_dir).expect("parent guard dir");
        fs::create_dir_all(&bin_dir).expect("bin");
        let parent_guard = parent_guard_dir.join("git");
        fs::write(&parent_guard, "#!/usr/bin/env sh\nexit 99\n").expect("parent guard");
        let real_git = write_fake_git(temp.path());
        let path_env = OsString::from(format!(
            "{}:{}",
            parent_guard_dir.to_string_lossy(),
            bin_dir.to_string_lossy()
        ));

        let resolved =
            find_real_git_from(&guard_dir, Some(path_env), Some(real_git.clone().into()))
                .expect("real git");

        assert_eq!(
            resolved, real_git,
            "nested guard should keep the real git path instead of wrapping {parent_guard:?}"
        );
    }

    fn write_test_guard(root: &Path) -> PathBuf {
        let path = root.join("git");
        fs::write(&path, build_git_clone_guard_script()).expect("write guard");
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("chmod guard");
        path
    }

    fn write_fake_git(root: &Path) -> PathBuf {
        let log = root.join("fake-git.log");
        let path = root.join("real-git");
        fs::write(
            &path,
            format!(
                "#!/usr/bin/env sh\nprintf '%s\\n' \"$*\" >> '{}'\nexit 0\n",
                log.to_string_lossy()
            ),
        )
        .expect("write fake git");
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("chmod fake git");
        path
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
