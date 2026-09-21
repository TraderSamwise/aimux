use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;

use crate::paths::{PathResolver, ProjectEntry};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JobScopeKind {
    Worktree,
    Project,
    Global,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum JobScope {
    Worktree {
        #[serde(rename = "projectId")]
        project_id: String,
        lane: String,
    },
    Project {
        #[serde(rename = "projectId")]
        project_id: String,
    },
    Global,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobAddress {
    pub scope: JobScope,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub slot: Vec<String>,
}

impl JobScope {
    pub fn global() -> Self {
        Self::Global
    }

    pub fn project_for(resolver: &mut PathResolver, cwd: impl AsRef<Path>) -> Self {
        Self::Project {
            project_id: resolver.project_id_for(cwd),
        }
    }

    pub fn worktree_for(
        resolver: &mut PathResolver,
        cwd: impl AsRef<Path>,
        lane: impl Into<String>,
    ) -> Self {
        Self::Worktree {
            project_id: resolver.project_id_for(cwd),
            lane: lane.into(),
        }
    }

    pub fn identity_value(&self) -> Value {
        match self {
            Self::Worktree { project_id, lane } => json!({
                "kind": "worktree",
                "projectId": project_id,
                "lane": lane,
            }),
            Self::Project { project_id } => json!({
                "kind": "project",
                "projectId": project_id,
            }),
            Self::Global => json!({ "kind": "global" }),
        }
    }

    pub fn project_id(&self) -> Option<&str> {
        match self {
            Self::Worktree { project_id, .. } | Self::Project { project_id } => Some(project_id),
            Self::Global => None,
        }
    }

    pub fn kind(&self) -> JobScopeKind {
        match self {
            Self::Worktree { .. } => JobScopeKind::Worktree,
            Self::Project { .. } => JobScopeKind::Project,
            Self::Global => JobScopeKind::Global,
        }
    }
}

impl JobAddress {
    pub fn identity_value(&self) -> Value {
        json!({
            "scope": self.scope.identity_value(),
            "slot": self.slot,
        })
    }

    pub fn display(&self) -> String {
        let prefix = match &self.scope {
            JobScope::Global => "global".to_owned(),
            JobScope::Project { project_id } => project_id.clone(),
            JobScope::Worktree { project_id, lane } => format!("{project_id}/{lane}"),
        };
        if self.slot.is_empty() {
            prefix
        } else {
            format!("{prefix}/{}", self.slot.join("/"))
        }
    }

    pub fn segments(&self) -> Vec<String> {
        let mut segments = match &self.scope {
            JobScope::Global => vec!["global".to_owned()],
            JobScope::Project { project_id } => vec![project_id.clone()],
            JobScope::Worktree { project_id, lane } => vec![project_id.clone(), lane.clone()],
        };
        segments.extend(self.slot.clone());
        segments
    }

    pub fn matches_prefix(&self, prefix: &JobAddress, depth: Option<usize>) -> bool {
        if self.scope.project_id() != prefix.scope.project_id() {
            return false;
        }
        let self_segments = self.segments();
        let prefix_segments = prefix.segments();
        let Some(suffix) = self_segments
            .as_slice()
            .strip_prefix(prefix_segments.as_slice())
        else {
            return false;
        };
        depth.is_none_or(|max_depth| suffix.len() <= max_depth)
    }
}

pub fn parse_job_scope_kind(value: &str) -> Option<JobScopeKind> {
    match value {
        "worktree" => Some(JobScopeKind::Worktree),
        "project" => Some(JobScopeKind::Project),
        "global" => Some(JobScopeKind::Global),
        _ => None,
    }
}

pub fn parse_job_address(
    address: &str,
    resolver: &mut PathResolver,
    explicit_project: Option<&Path>,
) -> Result<JobAddress, String> {
    parse_job_address_with_lane_lookup(address, resolver, explicit_project, |project_root| {
        worktree_lane_names(project_root)
    })
}

fn parse_job_address_with_lane_lookup(
    address: &str,
    resolver: &mut PathResolver,
    explicit_project: Option<&Path>,
    mut lane_lookup: impl FnMut(&Path) -> Result<BTreeSet<String>, String>,
) -> Result<JobAddress, String> {
    let raw = address.trim();
    if raw.is_empty() {
        return Err("job address is required".to_owned());
    }
    let segments = raw
        .split('/')
        .map(|segment| {
            if raw == "." && segment == "." && explicit_project.is_some() {
                Ok(segment)
            } else {
                validate_address_segment(segment).map(|_| segment)
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    if segments.is_empty() {
        return Err(format!("invalid job address: {address}"));
    }
    if segments.first() == Some(&"global") {
        return Ok(JobAddress {
            scope: JobScope::Global,
            slot: segments[1..]
                .iter()
                .map(|segment| (*segment).to_owned())
                .collect(),
        });
    }
    if let Some(project_root) = explicit_project {
        return match segments.as_slice() {
            ["."] => Ok(JobAddress {
                scope: JobScope::project_for(resolver, project_root),
                slot: Vec::new(),
            }),
            [] => Err(format!("invalid job address: {address}")),
            [first, rest @ ..] => {
                let lane_names = lane_lookup(project_root)?;
                if lane_names.contains(*first) {
                    Ok(JobAddress {
                        scope: JobScope::worktree_for(resolver, project_root, *first),
                        slot: rest.iter().map(|segment| (*segment).to_owned()).collect(),
                    })
                } else {
                    Ok(JobAddress {
                        scope: JobScope::project_for(resolver, project_root),
                        slot: segments
                            .iter()
                            .map(|segment| (*segment).to_owned())
                            .collect(),
                    })
                }
            }
        };
    }
    match segments.as_slice() {
        [project] => Ok(JobAddress {
            scope: project_scope_from_registry(resolver, project)?,
            slot: Vec::new(),
        }),
        [project, first, rest @ ..] => {
            let entry = resolve_project_entry_from_registry(resolver, project)?;
            let lane_names = lane_lookup(Path::new(&entry.repo_root))?;
            if lane_names.contains(*first) {
                Ok(JobAddress {
                    scope: JobScope::Worktree {
                        project_id: entry.id,
                        lane: (*first).to_owned(),
                    },
                    slot: rest.iter().map(|segment| (*segment).to_owned()).collect(),
                })
            } else {
                Ok(JobAddress {
                    scope: JobScope::Project {
                        project_id: entry.id,
                    },
                    slot: segments[1..]
                        .iter()
                        .map(|segment| (*segment).to_owned())
                        .collect(),
                })
            }
        }
        _ => Err(format!("invalid job address: {address}")),
    }
}

fn validate_address_segment(segment: &str) -> Result<(), String> {
    if segment.is_empty() {
        return Err(
            "job address segment cannot be empty; remove repeated or trailing slashes".to_owned(),
        );
    }
    if segment.trim() != segment || segment.chars().any(char::is_whitespace) {
        return Err(format!(
            "job address segment {segment:?} contains whitespace; use letters, numbers, '.', '_' or '-'"
        ));
    }
    if segment == "." || segment == ".." {
        return Err(format!(
            "job address segment {segment:?} is path traversal; use a named slot such as work or review"
        ));
    }
    if segment.starts_with("job-") {
        return Err(format!(
            "job address segment {segment:?} is reserved because job-* handles are job ids; use a different slot name"
        ));
    }
    if !segment
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        return Err(format!(
            "job address segment {segment:?} has unsupported characters; use letters, numbers, '.', '_' or '-'"
        ));
    }
    Ok(())
}

fn project_scope_from_registry(resolver: &PathResolver, project: &str) -> Result<JobScope, String> {
    let project_id = resolve_project_entry_from_registry(resolver, project)?.id;
    Ok(JobScope::Project { project_id })
}

fn resolve_project_entry_from_registry(
    resolver: &PathResolver,
    project: &str,
) -> Result<ProjectEntry, String> {
    if project == "global" {
        return Err(
            "global is reserved as a job scope; use --project for a project named global"
                .to_owned(),
        );
    }
    let registry = resolver
        .load_registry()
        .map_err(|error| format!("could not load project registry: {error}"))?;
    let matches = registry
        .projects
        .into_iter()
        .filter(|entry| entry.name == project || entry.id == project)
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [entry] => Ok(entry.clone()),
        [] => Err(format!(
            "unknown registered project for job address: {project}"
        )),
        _ => Err(format!(
            "ambiguous registered project for job address: {project}"
        )),
    }
}

fn worktree_lane_names(project_root: impl AsRef<Path>) -> Result<BTreeSet<String>, String> {
    let project_root = project_root.as_ref();
    let mut lanes = BTreeSet::from(["main".to_owned()]);
    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(project_root)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_COMMON_DIR")
        .output();
    let output = output.map_err(|error| {
        format!(
            "could not determine worktree lanes for {}: git worktree list failed to start: {error}",
            project_root.display()
        )
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(format!(
            "could not determine worktree lanes for {}: git worktree list exited with {}; {}",
            project_root.display(),
            output.status,
            stderr
        ));
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Some(path) = line.strip_prefix("worktree ") else {
            continue;
        };
        let path = Path::new(path);
        if path == project_root {
            lanes.insert("main".to_owned());
            continue;
        }
        if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
            lanes.insert(name.to_owned());
        }
    }
    Ok(lanes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::compute_project_id;
    use std::fs;
    use std::process::Command;

    #[test]
    fn parses_shared_scope_vocabulary() {
        assert_eq!(
            parse_job_scope_kind("worktree"),
            Some(JobScopeKind::Worktree)
        );
        assert_eq!(parse_job_scope_kind("project"), Some(JobScopeKind::Project));
        assert_eq!(parse_job_scope_kind("global"), Some(JobScopeKind::Global));
        assert_eq!(parse_job_scope_kind("main"), None);
    }

    #[test]
    fn parses_job_address_with_reserved_global_scope() {
        let cwd = std::env::temp_dir();
        let mut resolver = PathResolver::new(&cwd, cwd.join("home"), None);
        let global = parse_job_address("global/review-pr", &mut resolver, None).expect("global");
        assert_eq!(
            global,
            JobAddress {
                scope: JobScope::Global,
                slot: vec!["review-pr".to_owned()],
            }
        );
        let named_global =
            parse_job_address("global/main/review-pr", &mut resolver, None).expect("named global");
        assert_eq!(
            named_global,
            JobAddress {
                scope: JobScope::Global,
                slot: vec!["main".to_owned(), "review-pr".to_owned()],
            }
        );

        let project = cwd.join("global");
        let explicit = parse_job_address(".", &mut resolver, Some(&project)).expect("explicit");
        assert_eq!(
            explicit,
            JobAddress {
                scope: JobScope::Project {
                    project_id: compute_project_id(&project),
                },
                slot: Vec::new(),
            }
        );
    }

    #[test]
    fn parses_project_lane_slot_address_through_registry_identity() {
        let root =
            std::env::temp_dir().join(format!("aimux-jobs-scope-registry-{}", std::process::id()));
        let home = root.join("home");
        let registered = root.join("registered").join("tealstreet-next");
        let caller_a = root.join("caller-a");
        let caller_b = root.join("caller-b");
        init_git_repo(&registered);
        init_git_repo(&caller_a.join("tealstreet-next"));
        init_git_repo(&caller_b.join("tealstreet-next"));
        let mut registrar = PathResolver::new(&registered, &home, None);
        registrar
            .register_project(&registered)
            .expect("registered")
            .expect("project entry");
        let mut resolver_a = PathResolver::new(&caller_a, &home, None);
        let mut resolver_b = PathResolver::new(&caller_b, &home, None);
        let address_a = parse_job_address("tealstreet-next/main/review-pr", &mut resolver_a, None)
            .expect("address a");
        let address_b = parse_job_address("tealstreet-next/main/review-pr", &mut resolver_b, None)
            .expect("address b");
        assert_eq!(
            address_a,
            JobAddress {
                scope: JobScope::Worktree {
                    project_id: compute_project_id(&registered),
                    lane: "main".to_owned(),
                },
                slot: vec!["review-pr".to_owned()],
            }
        );
        assert_eq!(address_a, address_b);
    }

    #[test]
    fn lane_name_wins_over_project_slot_only_when_real_lane_exists() {
        let root =
            std::env::temp_dir().join(format!("aimux-jobs-lane-precedence-{}", std::process::id()));
        let home = root.join("home");
        let project = root.join("repo");
        let worktrees = root.join("worktrees");
        let feature = worktrees.join("feature");
        init_git_repo(&project);
        run_git(
            &project,
            &[
                "worktree",
                "add",
                feature.to_str().unwrap(),
                "-b",
                "feature",
            ],
        );
        let mut registrar = PathResolver::new(&project, &home, None);
        registrar
            .register_project(&project)
            .expect("registered")
            .expect("project entry");
        let mut resolver = PathResolver::new(&root, &home, None);
        let lane = parse_job_address("repo/feature", &mut resolver, None).expect("lane");
        assert_eq!(
            lane,
            JobAddress {
                scope: JobScope::Worktree {
                    project_id: compute_project_id(&project),
                    lane: "feature".to_owned(),
                },
                slot: Vec::new(),
            }
        );
        let slot = parse_job_address("repo/not-a-lane", &mut resolver, None).expect("slot");
        assert_eq!(
            slot,
            JobAddress {
                scope: JobScope::Project {
                    project_id: compute_project_id(&project),
                },
                slot: vec!["not-a-lane".to_owned()],
            }
        );
    }

    #[test]
    fn rejects_ambiguous_or_unsafe_address_segments_without_false_positives() {
        let cwd = std::env::temp_dir();
        let mut resolver = PathResolver::new(&cwd, cwd.join("home"), None);
        let job_prefix =
            parse_job_address("global/job-deadbeef", &mut resolver, None).expect_err("job prefix");
        assert!(job_prefix.contains("reserved"));
        let traversal = parse_job_address("global/..", &mut resolver, None).expect_err("traversal");
        assert!(traversal.contains("path traversal"));
        let empty = parse_job_address("global//slot", &mut resolver, None).expect_err("empty");
        assert!(empty.contains("empty"));
        let allowed =
            parse_job_address("global/jobs-deadbeef", &mut resolver, None).expect("allowed");
        assert_eq!(allowed.slot, vec!["jobs-deadbeef"]);

        let explicit_project = cwd.join("repo");
        let dotted_slot =
            parse_job_address("./x", &mut resolver, Some(&explicit_project)).expect_err("dot");
        assert!(dotted_slot.contains("path traversal"));
    }

    #[test]
    fn lane_lookup_failure_is_not_treated_as_no_lanes() {
        let root =
            std::env::temp_dir().join(format!("aimux-jobs-lane-failure-{}", std::process::id()));
        let home = root.join("home");
        let project = root.join("repo");
        init_git_repo(&project);
        let mut registrar = PathResolver::new(&project, &home, None);
        registrar
            .register_project(&project)
            .expect("registered")
            .expect("project entry");
        let mut resolver = PathResolver::new(&root, &home, None);

        let error = parse_job_address_with_lane_lookup("repo/feature", &mut resolver, None, |_| {
            Err("git worktree list failed".to_owned())
        })
        .expect_err("lane lookup failure");

        assert!(error.contains("git worktree list failed"));
    }

    #[test]
    fn address_prefix_matching_is_segment_based_and_depth_limited() {
        let target = JobAddress {
            scope: JobScope::Project {
                project_id: "tealstreet-next".to_owned(),
            },
            slot: Vec::new(),
        };
        let exact = target.clone();
        let child = JobAddress {
            scope: target.scope.clone(),
            slot: vec!["main".to_owned()],
        };
        let grandchild = JobAddress {
            scope: target.scope.clone(),
            slot: vec!["main".to_owned(), "foo".to_owned()],
        };
        let sibling_prefix_name = JobAddress {
            scope: JobScope::Project {
                project_id: "tealstreet-next-2".to_owned(),
            },
            slot: Vec::new(),
        };
        assert!(exact.matches_prefix(&target, Some(0)));
        assert!(child.matches_prefix(&target, Some(1)));
        assert!(!grandchild.matches_prefix(&target, Some(1)));
        assert!(grandchild.matches_prefix(&target, None));
        assert!(!sibling_prefix_name.matches_prefix(&target, None));
    }

    fn init_git_repo(path: &Path) {
        fs::create_dir_all(path).expect("repo dir");
        run_git(path, &["init"]);
        run_git(path, &["config", "user.email", "aimux@example.test"]);
        run_git(path, &["config", "user.name", "Aimux Test"]);
        fs::write(path.join("README.md"), "test\n").expect("readme");
        run_git(path, &["add", "README.md"]);
        run_git(path, &["commit", "-m", "initial"]);
    }

    fn run_git(path: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(path)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_OBJECT_DIRECTORY")
            .env_remove("GIT_COMMON_DIR")
            .output()
            .expect("git command");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
