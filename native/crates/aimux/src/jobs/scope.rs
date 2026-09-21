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
        [project, skill] => Ok(JobAddress {
            scope: JobScope::Project {
                project_id: resolver.project_id_for(project),
            },
            skill: (*skill).to_owned(),
        }),
        [project, lane, skill] => Ok(JobAddress {
            scope: JobScope::Worktree {
                project_id: resolver.project_id_for(project),
                lane: (*lane).to_owned(),
            },
            skill: (*skill).to_owned(),
        }),
        _ => Err(format!("invalid job address: {address}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::compute_project_id;

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
    fn parses_project_lane_skill_address() {
        let cwd = std::env::temp_dir();
        let mut resolver = PathResolver::new(&cwd, cwd.join("home"), None);
        let address = parse_job_address("tealstreet-next/main/review-pr", &mut resolver, None)
            .expect("address");
        assert_eq!(
            address,
            JobAddress {
                scope: JobScope::Worktree {
                    project_id: resolver.project_id_for("tealstreet-next"),
                    lane: "main".to_owned(),
                },
                skill: "review-pr".to_owned(),
            }
        );
    }
}
