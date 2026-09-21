use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;

use crate::paths::PathResolver;

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
    pub skill: String,
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

    pub fn kind(&self) -> JobScopeKind {
        match self {
            Self::Worktree { .. } => JobScopeKind::Worktree,
            Self::Project { .. } => JobScopeKind::Project,
            Self::Global => JobScopeKind::Global,
        }
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
    let segments = address
        .split('/')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    match segments.as_slice() {
        [skill] => {
            let Some(project_root) = explicit_project else {
                return Err("job address with one segment requires an explicit project".to_owned());
            };
            Ok(JobAddress {
                scope: JobScope::project_for(resolver, project_root),
                skill: (*skill).to_owned(),
            })
        }
        ["global", skill] => Ok(JobAddress {
            scope: JobScope::Global,
            skill: (*skill).to_owned(),
        }),
        ["global", _, _] => {
            Err("global job scope accepts exactly one skill segment: global/<skill>".to_owned())
        }
        [project, skill] => Ok(JobAddress {
            scope: project_scope_from_registry(resolver, project)?,
            skill: (*skill).to_owned(),
        }),
        [project, lane, skill] => Ok(JobAddress {
            scope: worktree_scope_from_registry(resolver, project, lane)?,
            skill: (*skill).to_owned(),
        }),
        _ => Err(format!("invalid job address: {address}")),
    }
}

fn project_scope_from_registry(resolver: &PathResolver, project: &str) -> Result<JobScope, String> {
    let project_id = resolve_project_id_from_registry(resolver, project)?;
    Ok(JobScope::Project { project_id })
}

fn worktree_scope_from_registry(
    resolver: &PathResolver,
    project: &str,
    lane: &str,
) -> Result<JobScope, String> {
    let project_id = resolve_project_id_from_registry(resolver, project)?;
    Ok(JobScope::Worktree {
        project_id,
        lane: lane.to_owned(),
    })
}

fn resolve_project_id_from_registry(
    resolver: &PathResolver,
    project: &str,
) -> Result<String, String> {
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
        [entry] => Ok(entry.id.clone()),
        [] => Err(format!(
            "unknown registered project for job address: {project}"
        )),
        _ => Err(format!(
            "ambiguous registered project for job address: {project}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::compute_project_id;
    use std::fs;

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
                skill: "review-pr".to_owned(),
            }
        );
        let three_segment_global = parse_job_address("global/main/review-pr", &mut resolver, None)
            .expect_err("global with lane should be rejected");
        assert!(three_segment_global.contains("global job scope"));

        let project = cwd.join("global");
        let explicit =
            parse_job_address("review-pr", &mut resolver, Some(&project)).expect("explicit");
        assert_eq!(
            explicit,
            JobAddress {
                scope: JobScope::Project {
                    project_id: compute_project_id(&project),
                },
                skill: "review-pr".to_owned(),
            }
        );
    }

    #[test]
    fn parses_project_lane_skill_address_through_registry_identity() {
        let root =
            std::env::temp_dir().join(format!("aimux-jobs-scope-registry-{}", std::process::id()));
        let home = root.join("home");
        let registered = root.join("registered").join("tealstreet-next");
        let caller_a = root.join("caller-a");
        let caller_b = root.join("caller-b");
        fs::create_dir_all(registered.join(".git")).expect("registered git marker");
        fs::create_dir_all(caller_a.join("tealstreet-next").join(".git"))
            .expect("caller a lexical project");
        fs::create_dir_all(caller_b.join("tealstreet-next").join(".git"))
            .expect("caller b lexical project");
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
                skill: "review-pr".to_owned(),
            }
        );
        assert_eq!(address_a, address_b);
    }
}
