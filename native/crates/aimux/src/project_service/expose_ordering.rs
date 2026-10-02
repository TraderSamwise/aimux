use serde_json::{Map, Value};
use std::cmp::Reverse;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::runtime_topology::list_topology_worktree_states;

use super::switchable_agents::SwitchableAgentItem;
use super::usage::parse_recency_timestamp;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExposeSublabel {
    None,
    Worktree,
    ProjectWorktree,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExposeOrderingOptions {
    pub worktree_order_by_project_root: BTreeMap<String, Vec<String>>,
    pub sort_mode_recent_output: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExposeGroup {
    pub label: String,
    pub items: Vec<SwitchableAgentItem>,
}

pub fn order_expose_items(
    items: &[SwitchableAgentItem],
    project_root: &str,
    sublabel: ExposeSublabel,
    options: &ExposeOrderingOptions,
) -> Vec<SwitchableAgentItem> {
    if options.sort_mode_recent_output {
        return partition_supervisor_plane_first(order_expose_items_by_recent_output(items));
    }
    if sublabel == ExposeSublabel::None {
        return partition_supervisor_plane_first(items.to_vec());
    }
    if sublabel == ExposeSublabel::Worktree {
        let groups = group_items_by_worktree(items, project_root, options);
        let ordered = if groups.len() < 2 {
            items.to_vec()
        } else {
            groups.into_iter().flat_map(|group| group.items).collect()
        };
        return partition_supervisor_plane_first(ordered);
    }
    let project_groups = group_items_by_project(items);
    if project_groups.len() < 2 {
        let root = items
            .first()
            .and_then(|item| item.project_root.as_deref())
            .unwrap_or(project_root);
        let worktree_groups = group_items_by_worktree(items, root, options);
        let ordered = if worktree_groups.len() < 2 {
            items.to_vec()
        } else {
            worktree_groups
                .into_iter()
                .flat_map(|group| group.items)
                .collect()
        };
        return partition_supervisor_plane_first(ordered);
    }
    let ordered = project_groups
        .into_iter()
        .flat_map(|project| {
            let root = project
                .items
                .first()
                .and_then(|item| item.project_root.as_deref())
                .unwrap_or(project_root)
                .to_owned();
            let groups = group_items_by_worktree(&project.items, &root, options);
            if groups.len() < 2 {
                project.items
            } else {
                groups.into_iter().flat_map(|group| group.items).collect()
            }
        })
        .collect();
    partition_supervisor_plane_first(ordered)
}

/// Planes are ours to order; what sits inside one is not. This sorted the
/// whole list by role display order, so the supervisor plane was "wherever the
/// overseer is" and an agent moved into it kept its worktree position. A
/// partition hoists the plane and leaves every item where the canonical
/// comparator already put it.
fn partition_supervisor_plane_first(items: Vec<SwitchableAgentItem>) -> Vec<SwitchableAgentItem> {
    let (supervisor, rest): (Vec<_>, Vec<_>) =
        items.into_iter().partition(item_is_in_supervisor_plane);
    supervisor.into_iter().chain(rest).collect()
}

fn item_is_in_supervisor_plane(item: &SwitchableAgentItem) -> bool {
    // The plane rides on the item and, for payloads built role-state first, on
    // `roleState.lane`. Reading only one of the two dropped half the plane.
    [item.role_state.get("lane"), Some(&item.lane)]
        .into_iter()
        .flatten()
        .any(|lane| lane.get("kind").and_then(Value::as_str) == Some("supervisor"))
}

/// Rank with no recency at all, matching the service's own missing-rank value.
const UNRANKED: i64 = 9_007_199_254_740_991;

/// The sort key for recent-output order, newest first, then the recent-jump
/// rank, then the order the service sent. Every surface that renders this order
/// sorts through it: `recencyAt` is written by several different producers, and
/// comparing it as text puts "…:00.500Z" before "…:00Z" and a non-Z offset
/// wherever its first character happens to fall.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct RecentOutputKey(Reverse<i128>, i64, usize);

pub fn recent_output_sort_key(
    recency_at: Option<&str>,
    recent_rank: Option<i64>,
    index: usize,
) -> RecentOutputKey {
    RecentOutputKey(
        Reverse(
            recency_at
                .and_then(parse_recency_timestamp)
                .map(|value| value as i128)
                .unwrap_or(i128::MIN),
        ),
        recent_rank.unwrap_or(UNRANKED),
        index,
    )
}

pub fn order_expose_items_by_recent_output(
    items: &[SwitchableAgentItem],
) -> Vec<SwitchableAgentItem> {
    let mut keyed = items
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, item)| {
            let key = recent_output_sort_key(
                item.metadata.get("recencyAt").and_then(Value::as_str),
                Some(item.recent_rank),
                index,
            );
            (key, item)
        })
        .collect::<Vec<_>>();
    keyed.sort_by_key(|(key, _)| *key);
    keyed.into_iter().map(|(_, item)| item).collect()
}

pub fn group_items_by_project(items: &[SwitchableAgentItem]) -> Vec<ExposeGroup> {
    let mut order = Vec::<String>::new();
    let mut buckets = BTreeMap::<String, Vec<SwitchableAgentItem>>::new();
    for item in items {
        let label = item
            .project_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("unknown project")
            .to_owned();
        if !buckets.contains_key(&label) {
            order.push(label.clone());
        }
        buckets.entry(label).or_default().push(item.clone());
    }
    order
        .into_iter()
        .map(|label| ExposeGroup {
            items: buckets.remove(&label).unwrap_or_default(),
            label,
        })
        .collect()
}

pub fn group_items_by_worktree(
    items: &[SwitchableAgentItem],
    project_root: &str,
    options: &ExposeOrderingOptions,
) -> Vec<ExposeGroup> {
    let mut order = Vec::<String>::new();
    let mut labels = BTreeMap::<String, String>::new();
    let mut buckets = BTreeMap::<String, Vec<SwitchableAgentItem>>::new();
    for item in items {
        let root = item.project_root.as_deref().unwrap_or(project_root);
        let key = worktree_tone_key(item, root);
        if !buckets.contains_key(&key) {
            labels.insert(key.clone(), short_worktree(item, root));
            order.push(key.clone());
        }
        buckets.entry(key).or_default().push(item.clone());
    }
    if order.len() >= 2 {
        let ranks = worktree_order_ranks(project_root, options);
        let first_seen = order
            .iter()
            .enumerate()
            .map(|(index, key)| (key.clone(), index))
            .collect::<BTreeMap<_, _>>();
        let fallback_rank = ranks.len();
        order.sort_by(|left, right| {
            let left_rank = ranks.get(left).copied().unwrap_or_else(|| {
                fallback_rank + first_seen.get(left).copied().unwrap_or_default()
            });
            let right_rank = ranks.get(right).copied().unwrap_or_else(|| {
                fallback_rank + first_seen.get(right).copied().unwrap_or_default()
            });
            left_rank.cmp(&right_rank)
        });
    }
    order
        .into_iter()
        .map(|key| ExposeGroup {
            label: labels.remove(&key).unwrap_or_else(|| "main".into()),
            items: buckets.remove(&key).unwrap_or_default(),
        })
        .collect()
}

pub fn dashboard_worktree_order_paths(project_root: &str, topology: &Value) -> Vec<String> {
    let root = clean_path_string(project_root);
    let mut secondary = list_topology_worktree_states(topology, None)
        .into_iter()
        .filter(|worktree| {
            worktree.get("isBare").and_then(Value::as_bool) != Some(true)
                && string_field(worktree, "path")
                    .is_some_and(|path| clean_path_string(path) != root)
        })
        .collect::<Vec<_>>();
    secondary.sort_by(|left, right| {
        dashboard_created_sort_key(right).cmp(&dashboard_created_sort_key(left))
    });
    let mut paths = vec![root];
    paths.extend(
        secondary
            .iter()
            .filter_map(|worktree| string_field(worktree, "path").map(str::to_owned)),
    );
    paths
}

pub fn assign_worktree_tones(
    items: &[SwitchableAgentItem],
    project_root: &str,
) -> BTreeMap<String, i64> {
    let mut tones = BTreeMap::new();
    for item in items {
        let root = item.project_root.as_deref().unwrap_or(project_root);
        let key = worktree_tone_key(item, root);
        tones.entry(key.clone()).or_insert_with(|| {
            worktree_color_code(Some(&key), Some(root), None, item.project_name.as_deref())
        });
    }
    tones
}

pub fn expose_tile_context_for_item(
    item: &SwitchableAgentItem,
    sublabel: ExposeSublabel,
    project_root: &str,
    tones: &BTreeMap<String, i64>,
) -> Value {
    let mut context = Map::new();
    if sublabel == ExposeSublabel::None {
        context.insert("worktree".into(), Value::String(String::new()));
        return Value::Object(context);
    }
    let root = item.project_root.as_deref().unwrap_or(project_root);
    let key = worktree_tone_key(item, root);
    context.insert("worktree".into(), Value::String(short_worktree(item, root)));
    if sublabel == ExposeSublabel::ProjectWorktree
        && let Some(project_name) = item.project_name.as_deref()
    {
        context.insert("project".into(), Value::String(project_name.to_owned()));
    }
    if let Some(tone) = tones.get(&key) {
        context.insert("tone".into(), Value::from(*tone));
    }
    Value::Object(context)
}

pub fn short_worktree(item: &SwitchableAgentItem, project_root: &str) -> String {
    let Some(worktree_path) = item
        .metadata
        .get("worktreePath")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return "main".into();
    };
    if clean_path_string(worktree_path) == clean_path_string(project_root) {
        return "main".into();
    }
    Path::new(worktree_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(worktree_path)
        .to_owned()
}

pub fn worktree_tone_key(item: &SwitchableAgentItem, project_root: &str) -> String {
    clean_path_string(
        item.metadata
            .get("worktreePath")
            .and_then(Value::as_str)
            .unwrap_or(project_root),
    )
}

fn worktree_order_ranks(
    project_root: &str,
    options: &ExposeOrderingOptions,
) -> BTreeMap<String, usize> {
    let root = clean_path_string(project_root);
    let paths = options
        .worktree_order_by_project_root
        .get(&root)
        .cloned()
        .unwrap_or_else(|| vec![root.clone()]);
    let mut ranks = BTreeMap::new();
    for path in paths {
        let key = clean_path_string(&path);
        if !ranks.contains_key(&key) {
            ranks.insert(key, ranks.len());
        }
    }
    if !ranks.contains_key(&root) {
        let mut shifted = BTreeMap::from([(root, 0)]);
        for (key, rank) in ranks {
            shifted.insert(key, rank + 1);
        }
        return shifted;
    }
    ranks
}

fn dashboard_created_sort_key(entry: &Value) -> i128 {
    if let Some(created_at) = string_field(entry, "createdAt")
        && let Some(parsed) = parse_recency_timestamp(created_at)
    {
        return parsed as i128;
    }
    entry
        .get("tmuxWindowIndex")
        .or_else(|| entry.get("index"))
        .and_then(Value::as_i64)
        .map(i128::from)
        .unwrap_or_default()
}

fn worktree_color_code(
    path: Option<&str>,
    project_root: Option<&str>,
    name: Option<&str>,
    project_name: Option<&str>,
) -> i64 {
    let key = worktree_color_key(path, project_root, name, project_name);
    worktree_color_code_for_key(key.as_deref(), "default")
}

fn worktree_color_key(
    path: Option<&str>,
    project_root: Option<&str>,
    name: Option<&str>,
    project_name: Option<&str>,
) -> Option<String> {
    let path = clean_key_part(path);
    if let Some(path) = path {
        return Some(format!("path:{path}"));
    }
    let project_root = clean_key_part(project_root);
    let name = clean_key_part(name);
    if let (Some(project_root), Some(name)) = (project_root.as_deref(), name.as_deref()) {
        return Some(format!("project-root:{project_root}\0name:{name}"));
    }
    if let Some(name) = name {
        return Some(format!("name:{name}"));
    }
    let project_name = clean_key_part(project_name);
    if let Some(project_root) = project_root {
        return Some(format!("project-root:{project_root}"));
    }
    project_name.map(|project_name| format!("project:{project_name}"))
}

fn worktree_color_code_for_key(key: Option<&str>, fallback_key: &str) -> i64 {
    let source = format!(
        "aimux-worktree-color-rgb:v7490:{}",
        key.unwrap_or(fallback_key)
    );
    let hash = mix32(stable_string_hash(&source));
    rgb_to_code(boosted_rgb_from_hash(hash))
}

fn stable_string_hash(value: &str) -> u32 {
    let mut hash = 0x811c9dc5_u32;
    for unit in value.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
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
            r = 255.min(r + 70);
        } else if max == g {
            g = 255.min(g + 70);
        } else {
            b = 255.min(b + 70);
        }

        if min == r {
            r = 65.max(r - 45);
        } else if min == g {
            g = 65.max(g - 45);
        } else {
            b = 65.max(b - 45);
        }
    }
    (r, g, b)
}

fn rgb_to_code((r, g, b): (i64, i64, i64)) -> i64 {
    ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
}

fn clean_key_part(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(collapse_slashes(&trimmed.replace('\\', "/")))
}

fn collapse_slashes(value: &str) -> String {
    let mut output = String::new();
    let mut previous_slash = false;
    for ch in value.chars() {
        if ch == '/' {
            if !previous_slash {
                output.push(ch);
            }
            previous_slash = true;
        } else {
            output.push(ch);
            previous_slash = false;
        }
    }
    output
}

fn clean_path_string(path: &str) -> String {
    path_clean(Path::new(path)).to_string_lossy().into_owned()
}

fn path_clean(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                output.push(component)
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                output.pop();
            }
            std::path::Component::Normal(part) => output.push(part),
        }
    }
    output
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
