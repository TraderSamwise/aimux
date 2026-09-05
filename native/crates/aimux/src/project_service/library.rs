use serde_json::{Map, Value, json};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::project_api_contract::routes;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;

struct LibraryDocumentSpec {
    path: &'static str,
    kind: &'static str,
    title: &'static str,
}

const LIBRARY_DOC_ALLOWLIST: &[LibraryDocumentSpec] = &[
    LibraryDocumentSpec {
        path: "AGENTS.md",
        kind: "instructions",
        title: "AGENTS.md",
    },
    LibraryDocumentSpec {
        path: "CLAUDE.md",
        kind: "adapter",
        title: "CLAUDE.md",
    },
    LibraryDocumentSpec {
        path: "CODEX.md",
        kind: "adapter",
        title: "CODEX.md",
    },
    LibraryDocumentSpec {
        path: "README.md",
        kind: "project",
        title: "README.md",
    },
];
const LIBRARY_ENTRY_DOCS: &[&str] = &["AGENTS.md", "CLAUDE.md", "CODEX.md", "README.md"];
const DEFAULT_PREVIEW_BYTES: usize = 4000;
const DOCUMENT_CONTENT_BYTES: usize = 40_000;

pub fn route_library_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
) -> Option<ProjectServiceDispatchResponse> {
    let pathname = project_service_pathname(path);
    if !method.eq_ignore_ascii_case("GET") || pathname != routes::LIBRARY {
        return None;
    }
    Some(ProjectServiceDispatchResponse {
        status: 200,
        body: json!({
            "ok": true,
            "documents": list_library_documents(context.project_root()),
            "entries": load_library_entries(context, DEFAULT_PREVIEW_BYTES),
        }),
    })
}

pub fn list_library_documents(project_root: impl AsRef<Path>) -> Vec<Value> {
    LIBRARY_DOC_ALLOWLIST
        .iter()
        .filter_map(|spec| {
            if !is_library_path_exposed(spec.path) {
                return None;
            }
            let path = project_root.as_ref().join(spec.path);
            let metadata = fs::metadata(&path).ok()?;
            if !metadata.is_file() {
                return None;
            }
            let content = fs::read_to_string(&path).ok()?;
            let mut entry = Map::new();
            entry.insert("id".into(), Value::String(spec.path.into()));
            entry.insert("title".into(), Value::String(spec.title.into()));
            entry.insert("path".into(), Value::String(spec.path.into()));
            entry.insert("kind".into(), Value::String(spec.kind.into()));
            entry.insert("size".into(), Value::Number(metadata.len().into()));
            entry.insert("updatedAt".into(), Value::String(path_mtime_iso(&path)));
            entry.insert(
                "content".into(),
                Value::String(take_bytes_lossy(&content, DOCUMENT_CONTENT_BYTES)),
            );
            entry.insert(
                "truncated".into(),
                Value::Bool(content.len() > DOCUMENT_CONTENT_BYTES),
            );
            Some(Value::Object(entry))
        })
        .collect()
}

pub fn load_library_entries(
    context: &ProjectServiceRequestContext,
    preview_bytes: usize,
) -> Vec<Value> {
    let mut entries = list_library_documents_with_preview(context.project_root(), preview_bytes);
    let plans_dir = context.project_root().join(".aimux").join("plans");
    let plan_files = fs::read_dir(plans_dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .filter_map(|entry| {
            let path = entry.path();
            (path.extension().and_then(|ext| ext.to_str()) == Some("md")).then_some(path)
        })
        .collect::<Vec<_>>();
    for path in plan_files {
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        if is_stub_plan(&content) {
            continue;
        }
        let Some(session_id) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let label = context.session_label(session_id);
        let mut entry = Map::new();
        entry.insert("id".into(), Value::String(format!("plan:{session_id}")));
        entry.insert("kind".into(), Value::String("plan".into()));
        entry.insert(
            "title".into(),
            Value::String(label.unwrap_or(session_id).to_owned()),
        );
        entry.insert("path".into(), Value::String(path_to_string(&path)));
        entry.insert("sessionId".into(), Value::String(session_id.to_owned()));
        if let Some(label) = label {
            entry.insert("label".into(), Value::String(label.to_owned()));
        }
        entry.insert(
            "updatedAt".into(),
            Value::String(
                frontmatter_updated_at(&content).unwrap_or_else(|| path_mtime_iso(&path)),
            ),
        );
        entry.insert(
            "preview".into(),
            Value::String(take_bytes_lossy(
                &strip_frontmatter(&content),
                preview_bytes,
            )),
        );
        entries.push(Value::Object(entry));
    }
    entries.sort_by(|left, right| {
        recency_ms(string_field(right, "updatedAt").unwrap_or(""))
            .cmp(&recency_ms(string_field(left, "updatedAt").unwrap_or("")))
    });
    entries
}

fn list_library_documents_with_preview(
    project_root: impl AsRef<Path>,
    preview_bytes: usize,
) -> Vec<Value> {
    LIBRARY_ENTRY_DOCS
        .iter()
        .filter_map(|file| {
            let path = project_root.as_ref().join(file);
            let content = fs::read_to_string(&path).ok()?;
            let mut entry = Map::new();
            entry.insert("id".into(), Value::String(format!("doc:{file}")));
            entry.insert("kind".into(), Value::String("doc".into()));
            entry.insert("title".into(), Value::String((*file).into()));
            entry.insert("path".into(), Value::String(path_to_string(&path)));
            entry.insert("updatedAt".into(), Value::String(path_mtime_iso(&path)));
            entry.insert(
                "preview".into(),
                Value::String(take_bytes_lossy(&content, preview_bytes)),
            );
            Some(Value::Object(entry))
        })
        .collect()
}

fn is_library_path_exposed(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_lowercase();
    !normalized.starts_with(".aimux/") && !normalized.ends_with("config.json")
}

pub fn is_stub_plan(content: &str) -> bool {
    let normalized = strip_frontmatter(&content.replace('\r', ""));
    normalized.contains("# Goal\n\nTBD")
        && normalized.contains("# Current Status\n\nTBD")
        && normalized.contains("# Steps\n\n- [ ] TBD")
}

fn strip_frontmatter(content: &str) -> String {
    if !content.starts_with("---") {
        return content.trim().to_owned();
    }
    let after_start = &content[3..];
    let after_newline = after_start
        .strip_prefix("\r\n")
        .or_else(|| after_start.strip_prefix('\n'));
    let Some(after_newline) = after_newline else {
        return content.trim().to_owned();
    };
    if let Some(index) = after_newline.find("\n---\n") {
        return after_newline[index + 5..].trim().to_owned();
    }
    if let Some(index) = after_newline.find("\r\n---\r\n") {
        return after_newline[index + 7..].trim().to_owned();
    }
    if let Some(index) = after_newline.find("\n---\r\n") {
        return after_newline[index + 6..].trim().to_owned();
    }
    if let Some(index) = after_newline.find("\r\n---\n") {
        return after_newline[index + 6..].trim().to_owned();
    }
    content.trim().to_owned()
}

fn frontmatter_updated_at(content: &str) -> Option<String> {
    if !content.starts_with("---") {
        return None;
    }
    let after_start = &content[3..];
    let after_newline = after_start
        .strip_prefix("\r\n")
        .or_else(|| after_start.strip_prefix('\n'))?;
    let end = after_newline
        .find("\n---")
        .or_else(|| after_newline.find("\r\n---"))?;
    for line in after_newline[..end].lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim() != "updatedAt" {
            continue;
        }
        let value = value.trim();
        if !value.is_empty() && parse_iso_millis(value).is_some() {
            return Some(value.to_owned());
        }
    }
    None
}

fn take_bytes_lossy(content: &str, max_bytes: usize) -> String {
    if content.len() <= max_bytes {
        return content.to_owned();
    }
    let mut end = max_bytes;
    while !content.is_char_boundary(end) {
        end -= 1;
    }
    content[..end].to_owned()
}

fn path_mtime_iso(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map(format_system_time)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".into())
}

fn format_system_time(time: SystemTime) -> String {
    let millis = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    iso_from_millis(millis)
}

fn recency_ms(value: &str) -> u128 {
    parse_iso_millis(value).unwrap_or_default()
}

fn parse_iso_millis(value: &str) -> Option<u128> {
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i64>().ok()?;
    let month = date_parts.next()?.parse::<i64>().ok()?;
    let day = date_parts.next()?.parse::<i64>().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let time = time.strip_suffix('Z')?;
    let (hms, millis) = time.split_once('.').unwrap_or((time, "0"));
    let mut time_parts = hms.split(':');
    let hour = time_parts.next()?.parse::<i64>().ok()?;
    let minute = time_parts.next()?.parse::<i64>().ok()?;
    let second = time_parts.next()?.parse::<i64>().ok()?;
    if time_parts.next().is_some() || hour > 23 || minute > 59 || second > 59 || millis.len() > 3 {
        return None;
    }
    let mut millis = millis.parse::<u128>().ok()?;
    for _ in 0..(3 - value
        .split_once('.')
        .map_or(0, |(_, rest)| rest.trim_end_matches('Z').len()))
    {
        millis *= 10;
    }
    let days = days_from_civil(year, month, day)?;
    Some(
        (((days as u128 * 24 + hour as u128) * 60 + minute as u128) * 60 + second as u128) * 1000
            + millis,
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    (days >= 0).then_some(days)
}

fn iso_from_millis(ms: u128) -> String {
    let seconds = (ms / 1000) as i64;
    let millis = (ms % 1000) as u16;
    let datetime = time::OffsetDateTime::from_unix_timestamp(seconds)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        datetime.year(),
        u8::from(datetime.month()),
        datetime.day(),
        datetime.hour(),
        datetime.minute(),
        datetime.second(),
        millis
    )
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
