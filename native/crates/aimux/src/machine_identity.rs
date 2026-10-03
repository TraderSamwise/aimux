//! Which machine this install is.
//!
//! The relay room is one per account and holds one daemon, so without a machine
//! dimension the second machine to connect evicts the first. The id is created
//! once and never changes; the name is only ever the OS hostname, and is allowed
//! to change under it.

use crate::atomic_write::{atomic_write_with_mode, quarantine_corrupt_file};
use crate::paths::PathResolver;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Short enough to read in a log line, long enough that two machines created in
/// the same nanosecond would still have to collide on a 96-bit prefix.
pub const MACHINE_ID_HEX_CHARS: usize = 24;
/// A name is a hostname, and a hostname is not a paragraph.
pub const MAX_MACHINE_NAME_CHARS: usize = 64;
pub const MAX_MACHINE_ID_CHARS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineIdentity {
    pub version: u8,
    pub id: String,
    pub name: String,
}

impl MachineIdentity {
    /// For a host whose identity file could not be read or written. Distinct
    /// from every other machine, so the relay still routes correctly; not
    /// persisted, so it changes on restart and the caller must say why it is
    /// being used.
    pub fn ephemeral(hostname: Option<&str>) -> Self {
        Self::fresh(hostname, now_nanos(), std::process::id())
    }

    fn fresh(hostname: Option<&str>, now_nanos: u128, pid: u32) -> Self {
        let id = derive_machine_id(hostname, now_nanos, pid);
        let name = hostname
            .and_then(sanitize_machine_name)
            .unwrap_or_else(|| id.clone());
        Self {
            version: 1,
            id,
            name,
        }
    }
}

/// The id the relay keeps for daemons that predate machine identity. It is a
/// real, matchable id otherwise, so a daemon that could ask for it could evict
/// such a daemon -- or be evicted by one.
pub const RESERVED_UNIDENTIFIED_MACHINE_ID: &str = "unidentified";

/// A machine id travels in a URL query string and in a relay socket tag, so it
/// is restricted to characters that need no encoding in either. Must agree with
/// the relay's own `isValidMachineId`.
pub fn is_valid_machine_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= MAX_MACHINE_ID_CHARS
        && id != RESERVED_UNIDENTIFIED_MACHINE_ID
        && id.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

/// The only source of a name is the OS hostname, and a hostname is already
/// URL-safe. Anything outside that set is not a hostname, so it is refused
/// rather than mangled or encoded — the caller falls back to the id.
pub fn sanitize_machine_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_MACHINE_NAME_CHARS {
        return None;
    }
    trimmed
        .chars()
        .all(|character| {
            character.is_ascii_alphanumeric()
                || character == '.'
                || character == '-'
                || character == '_'
        })
        .then(|| trimmed.to_owned())
}

/// POSIX does not promise a terminating NUL when the name is truncated, so the
/// end of the string is found rather than assumed. A trailing `.local` is
/// dropped: macOS churns that suffix (`host.local`, `host-2.local`) and a name
/// that moves with DHCP would rewrite the identity file on every reconnect.
pub fn os_hostname() -> Option<String> {
    let mut buffer = [0_u8; 256];
    let result =
        unsafe { libc::gethostname(buffer.as_mut_ptr().cast::<libc::c_char>(), buffer.len() - 1) };
    if result != 0 {
        return None;
    }
    let end = buffer
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(buffer.len());
    hostname_display_name(std::str::from_utf8(&buffer[..end]).ok()?)
}

/// The pure half of `os_hostname`, so the `.local` rule is testable without a
/// hostname this machine happens to have.
pub fn hostname_display_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    sanitize_machine_name(trimmed.strip_suffix(".local").unwrap_or(trimmed))
}

/// What is on disk, without creating anything.
///
/// For diagnostics. `load_or_create` is the wrong call for a report: it is the
/// first thing that can establish the identity, and if the write fails it
/// caches an ephemeral id for the rest of the process -- so merely running
/// `aimux doctor` on a full or read-only home would decide what the daemon
/// connects as. A report says what is there, including that nothing is.
pub fn read_stored(resolver: &PathResolver) -> io::Result<Option<MachineIdentity>> {
    match fs::read(resolver.machine_identity_path()) {
        Ok(bytes) => Ok(serde_json::from_slice::<MachineIdentity>(&bytes)
            .ok()
            .filter(|identity| identity.version == 1 && is_valid_machine_id(&identity.id))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn load_or_create(resolver: &PathResolver) -> io::Result<MachineIdentity> {
    load_or_create_at(resolver.machine_identity_path(), os_hostname().as_deref())
}

/// A missing file means create one. Any other read failure is an error, because
/// a home directory we cannot read is not the same answer as a machine we have
/// not named yet — treating them alike would mint a new id on every start.
pub fn load_or_create_at(
    path: impl AsRef<Path>,
    hostname: Option<&str>,
) -> io::Result<MachineIdentity> {
    load_or_create_with(path, hostname, now_nanos(), std::process::id())
}

pub fn load_or_create_with(
    path: impl AsRef<Path>,
    hostname: Option<&str>,
    now_nanos: u128,
    pid: u32,
) -> io::Result<MachineIdentity> {
    load_or_create_with_writer(path, hostname, now_nanos, pid, write_identity)
}

pub fn load_or_create_with_writer(
    path: impl AsRef<Path>,
    hostname: Option<&str>,
    now_nanos: u128,
    pid: u32,
    write: fn(&Path, &MachineIdentity) -> io::Result<()>,
) -> io::Result<MachineIdentity> {
    let path = path.as_ref();
    match fs::read(path) {
        Ok(bytes) => {
            let stored = serde_json::from_slice::<MachineIdentity>(&bytes)
                .ok()
                .filter(|identity| identity.version == 1 && is_valid_machine_id(&identity.id))
                // The name is formatted into the handshake URL, so a
                // hand-edited one carrying a space or a newline would break
                // every connect attempt.
                .map(|identity| MachineIdentity {
                    name: sanitize_machine_name(&identity.name)
                        .unwrap_or_else(|| identity.id.clone()),
                    ..identity
                });
            match stored {
                // The id survives a hostname change; the name follows it.
                Some(stored) => {
                    let name = hostname
                        .and_then(sanitize_machine_name)
                        .unwrap_or_else(|| stored.name.clone());
                    if name == stored.name {
                        return Ok(stored);
                    }
                    let renamed = MachineIdentity {
                        name,
                        ..stored.clone()
                    };
                    // A home we cannot write to must not cost us the id. The
                    // caller's fallback is a fresh in-memory id per call, which
                    // is the eviction this file exists to stop, so a rename we
                    // cannot persist keeps the old name and the right id.
                    match write(path, &renamed) {
                        Ok(()) => Ok(renamed),
                        Err(_) => Ok(stored),
                    }
                }
                // A hand-edited or truncated file is kept rather than deleted:
                // the id it held is the only record of what this machine was.
                None => {
                    quarantine_corrupt_file(path);
                    create_identity(path, hostname, now_nanos, pid, write)
                }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            create_identity(path, hostname, now_nanos, pid, write)
        }
        Err(error) => Err(error),
    }
}

/// Reads back what landed so two daemons starting together converge on one id
/// rather than each believing it wrote the file.
fn create_identity(
    path: &Path,
    hostname: Option<&str>,
    now_nanos: u128,
    pid: u32,
    write: fn(&Path, &MachineIdentity) -> io::Result<()>,
) -> io::Result<MachineIdentity> {
    let created = MachineIdentity::fresh(hostname, now_nanos, pid);
    write(path, &created)?;
    let landed = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<MachineIdentity>(&bytes).ok())
        .filter(|identity| identity.version == 1 && is_valid_machine_id(&identity.id));
    Ok(landed.unwrap_or(created))
}

fn write_identity(path: &Path, identity: &MachineIdentity) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut data = serde_json::to_string_pretty(identity).map_err(io::Error::other)?;
    data.push('\n');
    atomic_write_with_mode(path, data, Some(0o600))
}

fn derive_machine_id(hostname: Option<&str>, now_nanos: u128, pid: u32) -> String {
    let mut hasher = Sha256::new();
    hasher.update(hostname.unwrap_or_default().as_bytes());
    hasher.update(b"|");
    hasher.update(now_nanos.to_string().as_bytes());
    hasher.update(b"|");
    hasher.update(pid.to_string().as_bytes());
    format!("{:x}", hasher.finalize())[..MACHINE_ID_HEX_CHARS].to_owned()
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aimux-machine-identity-{}-{}",
            std::process::id(),
            name
        ));
        let _ = fs::remove_dir_all(&dir);
        dir.join("machine.json")
    }

    #[test]
    fn an_id_is_created_once_and_survives_every_later_load() {
        let path = temp_path("stable");
        let first = load_or_create_with(&path, Some("sam-mbp"), 1_000, 11).expect("create");
        let second = load_or_create_with(&path, Some("sam-mbp"), 2_000, 22).expect("reload");
        assert_eq!(first, second);
        assert_eq!(first.id.chars().count(), MACHINE_ID_HEX_CHARS);
        assert!(is_valid_machine_id(&first.id));
    }

    // The whole point of the file: renaming the box must not make it a new
    // machine, or the relay sees a stranger and the app loses its projects.
    #[test]
    fn a_renamed_host_keeps_its_id_and_takes_the_new_name() {
        let path = temp_path("renamed");
        let before = load_or_create_with(&path, Some("sam-mbp"), 1_000, 11).expect("create");
        let after = load_or_create_with(&path, Some("sam-strix"), 2_000, 22).expect("reload");
        assert_eq!(after.id, before.id);
        assert_eq!(after.name, "sam-strix");
        let reread = load_or_create_with(&path, Some("sam-strix"), 3_000, 33).expect("reread");
        assert_eq!(reread, after, "the new name was persisted");
    }

    #[test]
    fn two_machines_with_one_hostname_still_differ() {
        let left =
            load_or_create_with(temp_path("left"), Some("sam-mbp"), 1_000, 11).expect("left");
        let right =
            load_or_create_with(temp_path("right"), Some("sam-mbp"), 1_001, 11).expect("right");
        assert_ne!(left.id, right.id);
    }

    #[test]
    fn an_unreadable_home_is_an_error_not_a_new_machine() {
        let dir = std::env::temp_dir().join(format!(
            "aimux-machine-identity-{}-unreadable",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("machine.json");
        fs::write(&path, b"{}").expect("seed");
        // A directory where a file belongs: read fails with something other
        // than NotFound, and must not be mistaken for "not named yet".
        let as_dir = dir.join("as-dir");
        fs::create_dir_all(&as_dir).expect("mkdir");
        let error = load_or_create_with(&as_dir, Some("sam-mbp"), 1_000, 11)
            .expect_err("a directory is not a readable identity file");
        assert_ne!(error.kind(), io::ErrorKind::NotFound);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_file_is_replaced_rather_than_trusted() {
        let path = temp_path("corrupt");
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        fs::write(&path, b"not json").expect("seed");
        let identity = load_or_create_with(&path, Some("sam-mbp"), 1_000, 11).expect("recreate");
        assert!(is_valid_machine_id(&identity.id));
        assert_eq!(identity.name, "sam-mbp");
        let quarantined: Vec<_> = fs::read_dir(path.parent().expect("parent"))
            .expect("listing")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".corrupt-"))
            .collect();
        assert_eq!(
            quarantined.len(),
            1,
            "the unreadable file is kept, not deleted: {quarantined:?}"
        );
    }

    #[test]
    fn a_stored_id_outside_the_safe_charset_is_not_adopted() {
        let path = temp_path("unsafe-id");
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        fs::write(&path, br#"{"version":1,"id":"has spaces","name":"x"}"#).expect("seed");
        let identity = load_or_create_with(&path, Some("sam-mbp"), 1_000, 11).expect("recreate");
        assert!(is_valid_machine_id(&identity.id));
        assert_ne!(identity.id, "has spaces");
    }

    #[test]
    fn a_name_that_is_not_a_hostname_is_refused() {
        assert_eq!(
            sanitize_machine_name("  sam-mbp.local  "),
            Some("sam-mbp.local".to_owned())
        );
        assert_eq!(
            sanitize_machine_name("sam_mbp2"),
            Some("sam_mbp2".to_owned())
        );
        assert_eq!(sanitize_machine_name(""), None);
        assert_eq!(sanitize_machine_name("   "), None);
        assert_eq!(sanitize_machine_name("Sam's MacBook"), None);
        assert_eq!(sanitize_machine_name("host\nname"), None);
        assert_eq!(
            sanitize_machine_name(&"x".repeat(MAX_MACHINE_NAME_CHARS + 1)),
            None
        );
    }

    #[test]
    fn a_nameless_host_falls_back_to_its_id() {
        let path = temp_path("nameless");
        let identity = load_or_create_with(&path, None, 1_000, 11).expect("create");
        assert_eq!(identity.name, identity.id);
    }

    #[test]
    fn an_id_is_never_the_empty_string_or_over_long() {
        assert!(!is_valid_machine_id(""));
        assert!(!is_valid_machine_id(&"a".repeat(MAX_MACHINE_ID_CHARS + 1)));
        assert!(is_valid_machine_id("sam-mbp-01"));
        assert!(!is_valid_machine_id("SAM"));
        assert!(!is_valid_machine_id("sam mbp"));
    }

    // The slot the relay keeps for daemons that predate machine identity. A
    // daemon that could ask for it could evict such a daemon, or be evicted.
    #[test]
    fn the_reserved_id_is_refused() {
        assert!(!is_valid_machine_id(RESERVED_UNIDENTIFIED_MACHINE_ID));
        let path = temp_path("reserved");
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        fs::write(
            &path,
            format!(r#"{{"version":1,"id":"{RESERVED_UNIDENTIFIED_MACHINE_ID}","name":"x"}}"#),
        )
        .expect("seed");
        let identity = load_or_create_with(&path, Some("sam-mbp"), 1_000, 11).expect("recreate");
        assert_ne!(identity.id, RESERVED_UNIDENTIFIED_MACHINE_ID);
    }

    // The fallback for a failed load is a fresh id per call, so throwing away
    // a good id because the rename could not be written would reintroduce the
    // eviction this file exists to stop.
    #[test]
    fn a_home_we_cannot_write_keeps_the_id_it_already_had() {
        fn refuse(_: &Path, _: &MachineIdentity) -> io::Result<()> {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        }
        let path = temp_path("readonly");
        let created = load_or_create_with(&path, Some("sam-mbp"), 1_000, 11).expect("create");

        let renamed = load_or_create_with_writer(&path, Some("sam-strix"), 2_000, 22, refuse)
            .expect("a rename we cannot persist is not a failure to identify");

        assert_eq!(renamed.id, created.id);
        assert_eq!(renamed.name, created.name, "the rename did not persist");
    }

    // The name is formatted into the handshake URL, so one with a space in it
    // would break every connect attempt.
    #[test]
    fn a_hand_edited_name_is_re_sanitized_on_load() {
        let path = temp_path("edited-name");
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        fs::write(
            &path,
            br#"{"version":1,"id":"abc123def456","name":"sam mbp extra"}"#,
        )
        .expect("seed");
        let identity = load_or_create_with(&path, None, 1_000, 11).expect("load");
        assert_eq!(identity.id, "abc123def456");
        assert_eq!(identity.name, "abc123def456");
    }

    // The fallback when the identity cannot be persisted at all. Two hosts
    // that both fail must not land on the same id, or they evict each other.
    #[test]
    fn an_ephemeral_identity_is_still_distinct_per_call() {
        let first = MachineIdentity::ephemeral(Some("sam-mbp"));
        let second = MachineIdentity::ephemeral(Some("sam-mbp"));
        assert!(is_valid_machine_id(&first.id));
        assert_ne!(first.id, second.id);
        assert_eq!(first.name, "sam-mbp");
        assert_eq!(
            MachineIdentity::ephemeral(None).name.chars().count(),
            MACHINE_ID_HEX_CHARS
        );
    }

    // macOS churns the suffix (`host.local`, `host-2.local`), and a name that
    // moves with DHCP would rewrite the identity file on every reconnect.
    #[test]
    fn a_local_suffix_is_dropped_from_a_hostname() {
        assert_eq!(
            hostname_display_name("sam-mbp.local"),
            Some("sam-mbp".to_owned())
        );
        assert_eq!(hostname_display_name("sam-mbp"), Some("sam-mbp".to_owned()));
        assert_eq!(
            hostname_display_name("  sam-mbp.local  "),
            Some("sam-mbp".to_owned())
        );
        assert_eq!(hostname_display_name(".local"), None);
        assert_eq!(hostname_display_name("Sam's MacBook.local"), None);
    }

    #[test]
    fn the_hostname_this_machine_reports_is_usable_as_a_name() {
        // Not asserting a value -- asserting that whatever this box returns
        // passes the sanitizer, so a real machine never falls back to its id.
        if let Some(hostname) = os_hostname() {
            assert_eq!(
                sanitize_machine_name(&hostname).as_deref(),
                Some(hostname.as_str())
            );
        }
    }
}
