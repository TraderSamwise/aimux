use std::cell::RefCell;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
enum MemoEntry {
    Ok(String),
    Err(String),
}

thread_local! {
    static TMUX_QUERY_MEMO: RefCell<Option<HashMap<String, MemoEntry>>> = const { RefCell::new(None) };
}

struct TmuxQueryMemoGuard {
    owner: bool,
}

impl Drop for TmuxQueryMemoGuard {
    fn drop(&mut self) {
        if self.owner {
            TMUX_QUERY_MEMO.with(|memo| {
                *memo.borrow_mut() = None;
            });
        }
    }
}

pub fn with_tmux_query_memo<T>(fn_once: impl FnOnce() -> T) -> T {
    if is_in_tmux_query_memo_scope() {
        return fn_once();
    }
    TMUX_QUERY_MEMO.with(|memo| {
        *memo.borrow_mut() = Some(HashMap::new());
    });
    let _guard = TmuxQueryMemoGuard { owner: true };
    fn_once()
}

pub fn memoized_tmux_query(
    key: impl Into<String>,
    compute: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    let key = key.into();
    let hit = TMUX_QUERY_MEMO.with(|memo| {
        memo.borrow()
            .as_ref()
            .and_then(|entries| entries.get(&key).cloned())
    });
    if let Some(hit) = hit {
        return match hit {
            MemoEntry::Ok(value) => Ok(value),
            MemoEntry::Err(error) => Err(error),
        };
    }
    if !is_in_tmux_query_memo_scope() {
        return compute();
    }
    let result = compute();
    TMUX_QUERY_MEMO.with(|memo| {
        if let Some(entries) = memo.borrow_mut().as_mut() {
            entries.insert(
                key,
                match result.as_ref() {
                    Ok(value) => MemoEntry::Ok(value.clone()),
                    Err(error) => MemoEntry::Err(error.clone()),
                },
            );
        }
    });
    result
}

pub fn is_in_tmux_query_memo_scope() -> bool {
    TMUX_QUERY_MEMO.with(|memo| memo.borrow().is_some())
}

pub fn reset_tmux_query_memo() {
    TMUX_QUERY_MEMO.with(|memo| {
        if let Some(entries) = memo.borrow_mut().as_mut() {
            entries.clear();
        }
    });
}

pub fn is_read_only_tmux_verb(verb: &str) -> bool {
    matches!(
        verb,
        "-V" | "display-message"
            | "has-session"
            | "list-clients"
            | "list-panes"
            | "list-sessions"
            | "list-windows"
            | "show-options"
            | "show-window-options"
    )
}

pub fn is_non_caching_tmux_read(args: &[String]) -> bool {
    args.first().is_some_and(|verb| verb == "capture-pane") && args.iter().any(|arg| arg == "-p")
}

pub fn tmux_query_key(args: &[String], cwd: Option<&str>) -> String {
    let mut key = Vec::with_capacity(args.len() + 1);
    key.push(cwd.unwrap_or("").to_owned());
    key.extend(args.iter().cloned());
    serde_json::to_string(&key).expect("tmux query key should serialize")
}
