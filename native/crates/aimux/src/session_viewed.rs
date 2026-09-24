use serde_json::Value;
use std::path::Path;

use crate::config::load_config_for_project;
use crate::project_service::metadata::update_session_metadata;
use crate::project_service::notifications::{NotificationMutation, mark_notifications_read};
use crate::project_service::runtime_exchange::{runtime_exchange_path, update_runtime_exchange};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarkSessionViewedResult {
    pub notifications_read: usize,
    pub notification_threads_read: usize,
    pub attention_cleared: bool,
}

pub fn mark_session_viewed(
    project_root: impl AsRef<Path>,
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
) -> Result<MarkSessionViewedResult, String> {
    let project_state_dir = project_state_dir.as_ref();
    let config = load_config_for_project(project_root);
    let notifications = config.get("notifications").unwrap_or(&Value::Null);
    let mark_read_on_view = bool_field(notifications, "markReadOnView", true);
    let clear_needs_input = bool_field(notifications, "clearNeedsInputOnView", true);
    let clear_formal = bool_field(notifications, "clearFormalInteractionsOnView", false);
    let notifications_read = if mark_read_on_view {
        mark_notifications_read(
            project_state_dir,
            NotificationMutation {
                session_id: Some(session_id.to_owned()),
                ..NotificationMutation::default()
            },
        )?
    } else {
        0
    };
    // The count on a chip or a dashboard row is notification-tagged threads in
    // the runtime exchange that still list this agent in unreadBy, which is a
    // different store from the notifications above. Clearing only the latter is
    // why those counts never went down, from any surface.
    let notification_threads_read = if mark_read_on_view {
        clear_notification_threads(project_state_dir, session_id)?
    } else {
        0
    };
    let mut attention_cleared = false;
    update_session_metadata(project_state_dir, session_id, |current| {
        let mut object = current.as_object().cloned().unwrap_or_default();
        let mut derived = object
            .get("derived")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let attention = derived.get("attention").and_then(Value::as_str);
        let clear_attention = (clear_needs_input && attention == Some("needs_input"))
            || (clear_formal && attention == Some("needs_response"));
        attention_cleared = clear_attention;
        derived.insert("unseenCount".to_owned(), Value::Number(0.into()));
        if clear_attention {
            derived.insert("attention".to_owned(), Value::String("normal".to_owned()));
            if derived.get("activity").and_then(Value::as_str) == Some("waiting") {
                derived.insert("activity".to_owned(), Value::String("idle".to_owned()));
            }
        }
        object.insert("derived".to_owned(), Value::Object(derived));
        Value::Object(object)
    })?;
    Ok(MarkSessionViewedResult {
        notifications_read,
        notification_threads_read,
        attention_cleared,
    })
}

fn bool_field(value: &Value, field: &str, default_value: bool) -> bool {
    value
        .get(field)
        .and_then(Value::as_bool)
        .unwrap_or(default_value)
}

/// Drops `session_id` from `unreadBy` on every notification-tagged thread it
/// takes part in, which is what the unread count on a chip actually counts.
fn clear_notification_threads(project_state_dir: &Path, session_id: &str) -> Result<usize, String> {
    let mut cleared = 0_usize;
    update_runtime_exchange(runtime_exchange_path(project_state_dir), |mut exchange| {
        let Some(threads) = exchange.get_mut("threads").and_then(Value::as_array_mut) else {
            return exchange;
        };
        for thread in threads.iter_mut() {
            let tagged = thread
                .get("tags")
                .and_then(Value::as_array)
                .is_some_and(|tags| tags.iter().any(|tag| tag.as_str() == Some("notification")));
            if !tagged {
                continue;
            }
            let Some(unread_by) = thread.get_mut("unreadBy").and_then(Value::as_array_mut) else {
                continue;
            };
            let before = unread_by.len();
            unread_by.retain(|value| value.as_str() != Some(session_id));
            if unread_by.len() != before {
                cleared += 1;
            }
        }
        exchange
    })
    .map_err(|error| error.to_string())?;
    Ok(cleared)
}
