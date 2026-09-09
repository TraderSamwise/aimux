use serde_json::{Value, json};

pub fn worktree_color_key(input: &Value) -> Option<String> {
    let path = clean(input.get("path").and_then(Value::as_str));
    if let Some(path) = path {
        return Some(format!("path:{path}"));
    }
    let project_root = clean(input.get("projectRoot").and_then(Value::as_str));
    let name = clean(input.get("name").and_then(Value::as_str));
    if let (Some(project_root), Some(name)) = (project_root.as_deref(), name.as_deref()) {
        return Some(format!("project-root:{project_root}\0name:{name}"));
    }
    if let Some(name) = name {
        return Some(format!("name:{name}"));
    }
    let project_name = clean(input.get("projectName").and_then(Value::as_str));
    if let Some(project_root) = project_root {
        return Some(format!("project-root:{project_root}"));
    }
    project_name.map(|project_name| format!("project:{project_name}"))
}

pub fn stable_string_hash(value: &str) -> u32 {
    let mut hash = 0x811c9dc5_u32;
    for code_unit in value.encode_utf16() {
        hash ^= u32::from(code_unit);
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

pub fn worktree_color_code(input: &Value) -> i64 {
    worktree_color_code_for_key(worktree_color_key(input).as_deref(), "default")
}

pub fn worktree_color_code_for_key(key: Option<&str>, fallback_key: &str) -> i64 {
    let source = format!(
        "aimux-worktree-color-rgb:v7490:{}",
        key.unwrap_or(fallback_key)
    );
    rgb_to_code(boosted_rgb_from_hash(mix32(stable_string_hash(&source))))
}

pub fn rgb_from_worktree_color_code(code: i64) -> Value {
    json!({
        "r": (code >> 16) & 0xff,
        "g": (code >> 8) & 0xff,
        "b": code & 0xff,
    })
}

pub fn worktree_color_hex(input: &Value) -> String {
    worktree_color_hex_for_code(worktree_color_code(input))
}

pub fn worktree_color_hex_for_code(code: i64) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        (code >> 16) & 0xff,
        (code >> 8) & 0xff,
        code & 0xff
    )
}

pub fn worktree_color_ansi(input: &Value) -> String {
    worktree_color_ansi_for_code(worktree_color_code(input))
}

pub fn worktree_color_ansi_for_code(code: i64) -> String {
    format!(
        "38;2;{};{};{}",
        (code >> 16) & 0xff,
        (code >> 8) & 0xff,
        code & 0xff
    )
}

fn clean(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut cleaned = String::new();
    let mut previous_slash = false;
    for ch in trimmed.chars() {
        let ch = if ch == '\\' { '/' } else { ch };
        if ch == '/' {
            if !previous_slash {
                cleaned.push(ch);
            }
            previous_slash = true;
        } else {
            cleaned.push(ch);
            previous_slash = false;
        }
    }
    Some(cleaned)
}

fn rgb_to_code(rgb: (i64, i64, i64)) -> i64 {
    ((rgb.0 & 0xff) << 16) | ((rgb.1 & 0xff) << 8) | (rgb.2 & 0xff)
}

fn mix32(value: u32) -> u32 {
    let mut hash = value;
    hash ^= hash >> 16;
    hash = hash.wrapping_mul(0x7feb352d);
    hash ^= hash >> 15;
    hash = hash.wrapping_mul(0x846ca68b);
    hash ^= hash >> 16;
    hash
}

fn boosted_rgb_from_hash(hash: u32) -> (i64, i64, i64) {
    let mut r = 80 + i64::from((hash & 0xff) % 156);
    let mut g = 80 + i64::from(((hash >> 8) & 0xff) % 156);
    let mut b = 80 + i64::from(((hash >> 16) & 0xff) % 156);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    if max - min < 80 {
        if max == r {
            r = (r + 70).min(255);
        } else if max == g {
            g = (g + 70).min(255);
        } else {
            b = (b + 70).min(255);
        }

        if min == r {
            r = (r - 45).max(65);
        } else if min == g {
            g = (g - 45).max(65);
        } else {
            b = (b - 45).max(65);
        }
    }
    (r, g, b)
}
