use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

pub const PRIVATE_DIR_MODE: u32 = 0o700;
pub const PRIVATE_FILE_MODE: u32 = 0o600;

const LOCAL_AIMUX_SENSITIVE_DIRS: &[&str] = &[
    "attachments",
    "context",
    "history",
    "logs",
    "plans",
    "recordings",
    "session-input-ops",
    "session-messages",
    "status",
    "tasks",
    "threads",
];

const LOCAL_AIMUX_EXECUTABLE_OR_SOURCE_DIRS: &[&str] = &["plugins", "worktrees"];
const GLOBAL_AIMUX_EXECUTABLE_DIRS: &[&str] = &["native"];

pub fn ensure_private_dir(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    let missing = missing_ancestors(path);
    fs::create_dir_all(path)?;
    for created in missing.into_iter().rev() {
        set_private_dir_mode(&created)?;
    }
    set_private_dir_mode(path)
}

pub fn ensure_private_parent(path: impl AsRef<Path>) -> io::Result<()> {
    let parent = path
        .as_ref()
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    ensure_private_dir(parent)
}

pub fn open_private_append(path: impl AsRef<Path>) -> io::Result<File> {
    let path = path.as_ref();
    ensure_private_parent(path)?;
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(PRIVATE_FILE_MODE);
    }
    let file = options.open(path)?;
    set_private_file_mode(path)?;
    Ok(file)
}

pub fn truncate_private_file(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    ensure_private_parent(path)?;
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(PRIVATE_FILE_MODE);
    }
    let file = options.open(path)?;
    set_private_file_mode(path)?;
    drop(file);
    Ok(())
}

pub fn write_private_file_without_parent_chmod(
    path: impl AsRef<Path>,
    data: impl AsRef<[u8]>,
) -> io::Result<()> {
    let path = path.as_ref();
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(PRIVATE_FILE_MODE);
    }
    let mut file = options.open(path)?;
    file.write_all(data.as_ref())?;
    set_private_file_mode(path)?;
    Ok(())
}

pub fn set_private_file_mode(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Ok(());
    }
    set_mode(path, PRIVATE_FILE_MODE)
}

pub fn repair_project_local_store(project_root: impl AsRef<Path>) -> io::Result<()> {
    let local_dir = project_root.as_ref().join(".aimux");
    if !local_dir.exists() {
        return Ok(());
    }
    ensure_private_dir(&local_dir)?;
    repair_immediate_regular_files(&local_dir)?;
    for name in LOCAL_AIMUX_SENSITIVE_DIRS {
        repair_sensitive_tree(local_dir.join(name))?;
    }
    Ok(())
}

pub fn repair_registered_project_local_stores<I, P>(project_roots: I) -> io::Result<()>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    for project_root in project_roots {
        repair_project_local_store(project_root)?;
    }
    Ok(())
}

pub fn repair_global_aimux_home(aimux_home: impl AsRef<Path>) -> io::Result<()> {
    let aimux_home = aimux_home.as_ref();
    ensure_private_dir(aimux_home)?;
    for entry in fs::read_dir(aimux_home)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if GLOBAL_AIMUX_EXECUTABLE_DIRS.contains(&name) {
            continue;
        }
        repair_sensitive_tree(entry.path())?;
    }
    Ok(())
}

pub fn repair_project_state_store(project_state_dir: impl AsRef<Path>) -> io::Result<()> {
    repair_sensitive_tree(project_state_dir)
}

pub fn repair_sensitive_tree(root: impl AsRef<Path>) -> io::Result<()> {
    let root = root.as_ref();
    if !root.exists() {
        return Ok(());
    }
    repair_entry(root)
}

pub fn local_aimux_sensitive_dirs() -> &'static [&'static str] {
    LOCAL_AIMUX_SENSITIVE_DIRS
}

pub fn local_aimux_excluded_executable_or_source_dirs() -> &'static [&'static str] {
    LOCAL_AIMUX_EXECUTABLE_OR_SOURCE_DIRS
}

pub fn global_aimux_excluded_executable_dirs() -> &'static [&'static str] {
    GLOBAL_AIMUX_EXECUTABLE_DIRS
}

fn repair_immediate_regular_files(dir: &Path) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if LOCAL_AIMUX_EXECUTABLE_OR_SOURCE_DIRS.contains(&name) {
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_file() {
            set_mode(&path, PRIVATE_FILE_MODE)?;
        }
    }
    Ok(())
}

fn missing_ancestors(path: &Path) -> Vec<std::path::PathBuf> {
    let mut missing = Vec::new();
    let mut current = Some(path);
    while let Some(path) = current {
        if path.exists() {
            break;
        }
        missing.push(path.to_path_buf());
        current = path.parent();
    }
    missing
}

fn repair_entry(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Ok(());
    }
    if file_type.is_dir() {
        set_mode(path, PRIVATE_DIR_MODE)?;
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            repair_entry(&entry.path())?;
        }
        return Ok(());
    }
    if file_type.is_file() {
        set_mode(path, PRIVATE_FILE_MODE)?;
    }
    Ok(())
}

#[cfg(unix)]
fn set_private_dir_mode(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_dir() {
        set_mode(path, PRIVATE_DIR_MODE)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_private_dir_mode(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}
