use crate::tmux::{TmuxRuntimeManager, TmuxTarget};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use time::OffsetDateTime;

pub const EXPOSE_PANE_TAP_ACTIVE_MS: i64 = 10_000;
pub const EXPOSE_PANE_TAP_MAX_BYTES: usize = 128_000;
pub const EXPOSE_PANE_TAP_MAINTENANCE_MS: i64 = 1000;

static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExposePaneOutputTapItem {
    pub id: String,
    pub target: TmuxTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExposePaneOutputTapSnapshot {
    pub output: String,
    pub captured_at: String,
    pub source: String,
    pub window_id: String,
    pub byte_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExposePaneOutputTapStats {
    pub running: bool,
    pub tracked_targets: usize,
    pub pending_starts: usize,
    pub foreign_live_tokens: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanePipeOwnership {
    pub token: String,
    pub token_file_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanePipeFileOptions {
    pub only_if_not_piped: bool,
    pub ownership: Option<PanePipeOwnership>,
}

pub trait ExposePaneOutputTapTmux {
    fn is_pane_piped(&mut self, target: &TmuxTarget) -> bool;
    fn pipe_target_to_file(
        &mut self,
        target: &TmuxTarget,
        file_path: &Path,
        options: PanePipeFileOptions,
    ) -> Result<(), String>;
    fn stop_pane_pipe(&mut self, target: &TmuxTarget) -> Result<(), String>;
}

impl ExposePaneOutputTapTmux for TmuxRuntimeManager {
    fn is_pane_piped(&mut self, target: &TmuxTarget) -> bool {
        self.display_message("#{pane_pipe}", Some(&target.window_id))
            .as_deref()
            == Some("1")
    }

    fn pipe_target_to_file(
        &mut self,
        target: &TmuxTarget,
        file_path: &Path,
        options: PanePipeFileOptions,
    ) -> Result<(), String> {
        let file_path = file_path.to_string_lossy();
        let command = match options.ownership {
            Some(ownership) => {
                let token_file_path = ownership.token_file_path.to_string_lossy();
                let script = "token_file=$2; printf '%s\\t%s\\n' \"$$\" \"$1\" > \"$token_file\"; trap 'rm -f \"$token_file\"' EXIT; cat >> \"$3\"";
                format!(
                    "sh -c {} aimux-pane-tap {} {} {}",
                    shell_quote(script),
                    shell_quote(&ownership.token),
                    shell_quote(&token_file_path),
                    shell_quote(&file_path),
                )
            }
            None => format!("cat >> {}", shell_quote(&file_path)),
        };
        self.start_pane_pipe(target, &command, options.only_if_not_piped)
    }

    fn stop_pane_pipe(&mut self, target: &TmuxTarget) -> Result<(), String> {
        TmuxRuntimeManager::stop_pane_pipe(self, target)
    }
}

pub struct ExposePaneOutputTapOptions {
    pub project_state_dir: PathBuf,
    pub active_ms: i64,
    pub max_bytes: usize,
    pub maintenance_ms: i64,
    pub now_millis: Box<dyn Fn() -> i64>,
}

impl ExposePaneOutputTapOptions {
    pub fn new(project_state_dir: impl Into<PathBuf>) -> Self {
        Self {
            project_state_dir: project_state_dir.into(),
            active_ms: EXPOSE_PANE_TAP_ACTIVE_MS,
            max_bytes: EXPOSE_PANE_TAP_MAX_BYTES,
            maintenance_ms: EXPOSE_PANE_TAP_MAINTENANCE_MS,
            now_millis: Box::new(system_now_millis),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TrackedExposePaneOutputTap {
    item: ExposePaneOutputTapItem,
    expires_at: i64,
    file_path: PathBuf,
    token: String,
    token_file_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingExposePaneOutputTapStart {
    tracked: TrackedExposePaneOutputTap,
    started_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingPromotionResult {
    None,
    Promoted,
    Discarded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TapOwnershipToken {
    token: String,
    pid: Option<i32>,
}

pub struct ExposePaneOutputTap<T: ExposePaneOutputTapTmux> {
    tmux: T,
    active_ms: i64,
    max_bytes: usize,
    maintenance_ms: i64,
    now_millis: Box<dyn Fn() -> i64>,
    tap_dir: PathBuf,
    tracked_targets: BTreeMap<String, TrackedExposePaneOutputTap>,
    pending_starts: BTreeMap<String, PendingExposePaneOutputTapStart>,
    foreign_live_tokens: BTreeMap<String, String>,
    running: bool,
}

impl<T: ExposePaneOutputTapTmux> ExposePaneOutputTap<T> {
    pub fn new(options: ExposePaneOutputTapOptions, tmux: T) -> Self {
        let tap_dir = options.project_state_dir.join("expose-pane-taps");
        Self {
            tmux,
            active_ms: options.active_ms,
            max_bytes: options.max_bytes,
            maintenance_ms: options.maintenance_ms.max(1),
            now_millis: options.now_millis,
            tap_dir,
            tracked_targets: BTreeMap::new(),
            pending_starts: BTreeMap::new(),
            foreign_live_tokens: BTreeMap::new(),
            running: false,
        }
    }

    pub fn into_tmux(self) -> T {
        self.tmux
    }

    pub fn tmux_mut(&mut self) -> &mut T {
        &mut self.tmux
    }

    pub fn tap_dir(&self) -> &Path {
        &self.tap_dir
    }

    pub fn start(&mut self) {
        if self.running {
            return;
        }
        self.running = true;
        let _ = fs::create_dir_all(&self.tap_dir);
    }

    pub fn stop(&mut self) {
        self.running = false;
        let tracked: Vec<_> = self.tracked_targets.values().cloned().collect();
        let pending: Vec<_> = self
            .pending_starts
            .values()
            .map(|pending| pending.tracked.clone())
            .collect();
        self.tracked_targets.clear();
        self.pending_starts.clear();
        self.foreign_live_tokens.clear();
        for item in tracked {
            self.stop_tracked(&item);
        }
        for item in pending {
            self.stop_tracked(&item);
        }
    }

    pub fn track_items(&mut self, items: &[ExposePaneOutputTapItem]) {
        if !self.running {
            return;
        }
        let now = (self.now_millis)();
        self.reconcile_pending_starts(now);
        self.prune_expired(now);
        if items.is_empty() {
            return;
        }
        if fs::create_dir_all(&self.tap_dir).is_err() {
            return;
        }
        let expires_at = now + self.active_ms;
        for item in items {
            let window_id = item.target.window_id.clone();
            let mut current = self.tracked_targets.remove(&window_id);
            if let Some(current_item) = current.as_mut()
                && same_target(&current_item.item.target, &item.target)
                && current_item.file_path.exists()
            {
                if owns_token(&current_item.token_file_path, &current_item.token) {
                    current_item.item.id = item.id.clone();
                    current_item.expires_at = expires_at;
                    self.compact_file(&current_item.file_path);
                    self.tracked_targets
                        .insert(window_id.clone(), current_item.clone());
                    continue;
                }
                self.stop_tracked(current_item);
                current = None;
            }

            let mut pending = self.pending_starts.remove(&window_id);
            if let Some(pending_item) = pending.as_mut()
                && same_target(&pending_item.tracked.item.target, &item.target)
                && pending_item.tracked.file_path.exists()
            {
                pending_item.tracked.item.id = item.id.clone();
                let promotion = self.promote_pending_start(&window_id, pending_item.clone(), now);
                if promotion == PendingPromotionResult::Promoted {
                    if let Some(promoted) = self.tracked_targets.get_mut(&window_id) {
                        promoted.item.id = item.id.clone();
                        promoted.expires_at = expires_at;
                        let file_path = promoted.file_path.clone();
                        self.compact_file(&file_path);
                        continue;
                    }
                    pending = None;
                } else if promotion == PendingPromotionResult::Discarded {
                    continue;
                } else if now - pending_item.started_at < self.maintenance_ms {
                    self.pending_starts
                        .insert(window_id.clone(), pending_item.clone());
                    continue;
                } else {
                    self.stop_tracked(&pending_item.tracked);
                    pending = None;
                }
            }

            if let Some(current_item) = current {
                self.stop_tracked(&current_item);
            }
            if let Some(pending_item) = pending {
                self.stop_tracked(&pending_item.tracked);
            }
            self.start_tracked(item, expires_at);
        }
    }

    pub fn read(
        &mut self,
        window_id: &str,
        max_bytes: Option<usize>,
    ) -> Option<ExposePaneOutputTapSnapshot> {
        let now = (self.now_millis)();
        self.reconcile_pending_starts(now);
        self.prune_expired(now);
        let current = self.tracked_targets.get(window_id)?.clone();
        if !owns_token(&current.token_file_path, &current.token) {
            self.tracked_targets.remove(window_id);
            self.stop_tracked(&current);
            return None;
        }
        let limit = max_bytes.unwrap_or(self.max_bytes).min(self.max_bytes);
        if limit == 0 {
            return None;
        }
        let tail = read_tail(&current.file_path, limit)?;
        if tail.buffer.is_empty() {
            return None;
        }
        if tail.total_bytes > self.max_bytes {
            self.compact_file(&current.file_path);
        }
        Some(ExposePaneOutputTapSnapshot {
            output: String::from_utf8_lossy(&tail.buffer).into_owned(),
            captured_at: iso_from_millis((self.now_millis)()),
            source: "tap".to_owned(),
            window_id: window_id.to_owned(),
            byte_count: tail.buffer.len(),
        })
    }

    pub fn stats(&mut self) -> ExposePaneOutputTapStats {
        let now = (self.now_millis)();
        self.reconcile_pending_starts(now);
        self.prune_expired(now);
        ExposePaneOutputTapStats {
            running: self.running,
            tracked_targets: self.tracked_targets.len(),
            pending_starts: self.pending_starts.len(),
            foreign_live_tokens: self.foreign_live_tokens.len(),
        }
    }

    pub fn compact_tracked_files_for_test(&mut self) {
        let now = (self.now_millis)();
        self.reconcile_pending_starts(now);
        self.prune_expired(now);
        self.compact_tracked_files(now);
    }

    fn start_tracked(&mut self, item: &ExposePaneOutputTapItem, expires_at: i64) {
        let file_path = self.tap_file_path(&item.target.window_id);
        let token_file_path = self.tap_token_file_path(&item.target.window_id);
        let cleanup_file_path = file_path.clone();
        let cleanup_token_file_path = token_file_path.clone();
        let result = (|| -> Result<(), String> {
            if let Some(foreign_token) = self.foreign_live_tokens.get(&item.target.window_id) {
                let ownership = read_ownership_token(&token_file_path);
                if ownership.as_ref().is_some_and(|ownership| {
                    ownership.token == *foreign_token && is_ownership_live(ownership)
                }) {
                    return Ok(());
                }
                self.foreign_live_tokens.remove(&item.target.window_id);
            }
            if self.tmux.is_pane_piped(&item.target) {
                self.adopt_existing_tap(
                    item,
                    expires_at,
                    file_path.clone(),
                    token_file_path.clone(),
                );
                return Ok(());
            }
            let token = new_token();
            let _ = fs::remove_file(&file_path);
            let _ = fs::remove_file(&token_file_path);
            fs::write(&file_path, b"").map_err(|error| error.to_string())?;
            self.tmux.pipe_target_to_file(
                &item.target,
                &file_path,
                PanePipeFileOptions {
                    only_if_not_piped: true,
                    ownership: Some(PanePipeOwnership {
                        token: token.clone(),
                        token_file_path: token_file_path.clone(),
                    }),
                },
            )?;
            if !wait_for_ownership_token(&token_file_path, &token) {
                self.pending_starts.insert(
                    item.target.window_id.clone(),
                    PendingExposePaneOutputTapStart {
                        tracked: TrackedExposePaneOutputTap {
                            item: item.clone(),
                            expires_at,
                            file_path,
                            token,
                            token_file_path,
                        },
                        started_at: (self.now_millis)(),
                    },
                );
                return Ok(());
            }
            self.tracked_targets.insert(
                item.target.window_id.clone(),
                TrackedExposePaneOutputTap {
                    item: item.clone(),
                    expires_at,
                    file_path,
                    token,
                    token_file_path,
                },
            );
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(cleanup_file_path);
            let _ = fs::remove_file(cleanup_token_file_path);
        }
    }

    fn adopt_existing_tap(
        &mut self,
        item: &ExposePaneOutputTapItem,
        expires_at: i64,
        file_path: PathBuf,
        token_file_path: PathBuf,
    ) {
        let Some(ownership) = read_ownership_token(&token_file_path) else {
            remove_dead_tap_files(&file_path, &token_file_path);
            return;
        };
        if !is_ownership_live(&ownership) {
            remove_dead_tap_files(&file_path, &token_file_path);
            return;
        }
        self.tracked_targets.insert(
            item.target.window_id.clone(),
            TrackedExposePaneOutputTap {
                item: item.clone(),
                expires_at,
                file_path,
                token: ownership.token,
                token_file_path,
            },
        );
    }

    fn stop_tracked(&mut self, item: &TrackedExposePaneOutputTap) {
        let ownership = read_ownership_token(&item.token_file_path);
        if ownership
            .as_ref()
            .is_some_and(|ownership| ownership.token != item.token && is_ownership_live(ownership))
        {
            if let Some(ownership) = ownership {
                self.foreign_live_tokens
                    .insert(item.item.target.window_id.clone(), ownership.token);
            }
            return;
        }
        if owns_token(&item.token_file_path, &item.token) {
            let _ = self.tmux.stop_pane_pipe(&item.item.target);
        }
        let _ = fs::remove_file(&item.file_path);
        let _ = fs::remove_file(&item.token_file_path);
    }

    fn prune_expired(&mut self, now: i64) {
        let expired: Vec<String> = self
            .tracked_targets
            .iter()
            .filter(|(_, item)| now >= item.expires_at)
            .map(|(window_id, _)| window_id.clone())
            .collect();
        for window_id in expired {
            if let Some(item) = self.tracked_targets.remove(&window_id) {
                self.stop_tracked(&item);
            }
        }
        let expired_pending: Vec<String> = self
            .pending_starts
            .iter()
            .filter(|(_, item)| now >= item.tracked.expires_at)
            .map(|(window_id, _)| window_id.clone())
            .collect();
        for window_id in expired_pending {
            if let Some(item) = self.pending_starts.remove(&window_id) {
                self.stop_tracked(&item.tracked);
            }
        }
    }

    fn compact_file(&self, file_path: &Path) {
        let Some(tail) = read_tail(file_path, self.max_bytes) else {
            return;
        };
        if tail.total_bytes <= self.max_bytes {
            return;
        }
        let _ = fs::write(file_path, tail.buffer);
    }

    fn compact_tracked_files(&self, now: i64) {
        for item in self.tracked_targets.values() {
            if now < item.expires_at {
                self.compact_file(&item.file_path);
            }
        }
    }

    fn reconcile_pending_starts(&mut self, now: i64) {
        let window_ids: Vec<String> = self.pending_starts.keys().cloned().collect();
        for window_id in window_ids {
            let Some(item) = self.pending_starts.get(&window_id).cloned() else {
                continue;
            };
            if self.promote_pending_start(&window_id, item.clone(), now)
                != PendingPromotionResult::None
            {
                continue;
            }
            let ownership = read_ownership_token(&item.tracked.token_file_path);
            if ownership.is_none() && now - item.started_at < self.maintenance_ms {
                continue;
            }
            if ownership.as_ref().is_some_and(is_ownership_live) {
                continue;
            }
            self.pending_starts.remove(&window_id);
            self.stop_tracked(&item.tracked);
        }
    }

    fn promote_pending_start(
        &mut self,
        window_id: &str,
        item: PendingExposePaneOutputTapStart,
        now: i64,
    ) -> PendingPromotionResult {
        let Some(ownership) = read_ownership_token(&item.tracked.token_file_path) else {
            return PendingPromotionResult::None;
        };
        if !is_ownership_live(&ownership) {
            return PendingPromotionResult::None;
        }
        self.pending_starts.remove(window_id);
        if ownership.token != item.tracked.token {
            self.foreign_live_tokens
                .insert(window_id.to_owned(), ownership.token);
            return PendingPromotionResult::Discarded;
        }
        let mut tracked = item.tracked;
        tracked.token = ownership.token;
        if now < tracked.expires_at {
            self.tracked_targets.insert(window_id.to_owned(), tracked);
        } else {
            self.stop_tracked(&tracked);
        }
        PendingPromotionResult::Promoted
    }

    fn tap_file_path(&self, window_id: &str) -> PathBuf {
        self.tap_dir
            .join(format!("{}.log", tap_file_stem(window_id)))
    }

    fn tap_token_file_path(&self, window_id: &str) -> PathBuf {
        self.tap_dir
            .join(format!("{}.token", tap_file_stem(window_id)))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TailRead {
    buffer: Vec<u8>,
    total_bytes: usize,
}

fn read_tail(file_path: &Path, max_bytes: usize) -> Option<TailRead> {
    let mut file = File::open(file_path).ok()?;
    let total_bytes = file.metadata().ok()?.len() as usize;
    let byte_count = total_bytes.min(max_bytes);
    let start = total_bytes.saturating_sub(byte_count);
    file.seek(SeekFrom::Start(start as u64)).ok()?;
    let mut buffer = vec![0; byte_count];
    let bytes_read = file.read(&mut buffer).ok()?;
    buffer.truncate(bytes_read);
    Some(TailRead {
        buffer,
        total_bytes,
    })
}

fn owns_token(token_file_path: &Path, token: &str) -> bool {
    read_ownership_token(token_file_path)
        .as_ref()
        .is_some_and(|ownership| ownership.token == token && is_ownership_live(ownership))
}

fn read_ownership_token(token_file_path: &Path) -> Option<TapOwnershipToken> {
    let raw = fs::read_to_string(token_file_path).ok()?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let mut parts = raw.split_whitespace();
    let first = parts.next().unwrap_or_default();
    let second = parts.next();
    if let Some(token) = second
        && first.chars().all(|character| character.is_ascii_digit())
    {
        return Some(TapOwnershipToken {
            token: token.to_owned(),
            pid: first.parse::<i32>().ok(),
        });
    }
    Some(TapOwnershipToken {
        token: raw.to_owned(),
        pid: None,
    })
}

fn wait_for_ownership_token(token_file_path: &Path, token: &str) -> bool {
    for _ in 0..5 {
        if owns_token(token_file_path, token) {
            return true;
        }
        thread::sleep(Duration::from_millis(2));
    }
    false
}

fn is_ownership_live(ownership: &TapOwnershipToken) -> bool {
    let Some(pid) = ownership.pid else {
        return true;
    };
    unsafe { libc::kill(pid, 0) == 0 }
}

fn remove_dead_tap_files(file_path: &Path, token_file_path: &Path) {
    let _ = fs::remove_file(file_path);
    let _ = fs::remove_file(token_file_path);
}

fn same_target(left: &TmuxTarget, right: &TmuxTarget) -> bool {
    left.window_id == right.window_id
}

fn tap_file_stem(window_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(window_id.as_bytes());
    let digest = hasher.finalize();
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn new_token() -> String {
    let sequence = TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("aimux-rust-{}-{sequence}", std::process::id())
}

fn system_now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn iso_from_millis(millis: i64) -> String {
    let value = OffsetDateTime::from_unix_timestamp_nanos((millis as i128) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        value.year(),
        value.month() as u8,
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
        value.millisecond()
    )
}

fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_owned();
    }
    let safe = value.chars().all(|ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '/' | '.' | ':' | ',' | '=')
    });
    if safe {
        return value.to_owned();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}
