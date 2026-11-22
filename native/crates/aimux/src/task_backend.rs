//! Which system owns this account's tasks.
//!
//! Sam's decision, and it is the reason this file exists: **Linear REPLACES
//! `aimux task` once a Linear account is configured.** The primitive engine
//! still works standalone, so the question is not "is Linear reachable" but
//! "has somebody chosen it".
//!
//! Before this, configuring Linear changed NOTHING. `aimux task assign` went
//! on writing the local exchange while the config said tasks lived in Linear,
//! which is the exact harm the settings work was written to avoid: tasks split
//! across two systems with nothing saying so. A refusal that names the owner
//! is worse for one command and better for everything downstream, because the
//! alternative is a task nobody can find.

use crate::linear_settings::{LinearSettings, LinearToken};

/// Who owns tasks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskBackend {
    /// Nobody chose Linear, so the local exchange owns tasks and every verb
    /// works exactly as it did.
    Local,
    /// Linear owns tasks, for this project.
    Linear { project: String },
    /// The config points at Linear and Linear cannot be used. Carries why.
    ///
    /// Separate from `Local` on purpose, and this is the distinction the whole
    /// module turns on: falling back to the local engine here would write a
    /// task to a system the config says is not in charge, and say nothing.
    Misconfigured(String),
}

/// Decide the owner from the settings and the token.
pub fn task_backend(settings: &LinearSettings, token: &LinearToken) -> TaskBackend {
    match settings {
        // Nobody chose Linear. This is the standalone case Sam asked to keep
        // working, and it must stay the common path.
        LinearSettings::Absent => TaskBackend::Local,
        // The config is there and we could not read it. It may well name
        // Linear, so this is NOT the local case.
        LinearSettings::Unreadable(reason) => TaskBackend::Misconfigured(format!(
            "The Linear settings could not be read, so it is unclear where tasks belong: {reason}"
        )),
        LinearSettings::Configured { project, .. } => match token {
            LinearToken::Readable { .. } => TaskBackend::Linear {
                project: project.clone(),
            },
            // Chosen but unreachable. The task still belongs to Linear, so the
            // local engine is not the answer -- it is just that nothing can
            // reach the owner yet.
            other => TaskBackend::Misconfigured(format!(
                "Tasks belong to the Linear project {project}, but Linear cannot be reached. {}",
                crate::linear_settings::linear_token_line(other)
            )),
        },
    }
}

/// What the local engine should do with one task mutation.
///
/// The verb no longer matters here. It did for exactly one change, while
/// filing a new task into Linear was built and moving an existing issue was
/// not -- so this took a `creates` bool and refused the moves. Both are built
/// now, so the bool is gone rather than left as a parameter nothing reads; the
/// dispatcher still distinguishes the two, because they call different things.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalTaskVerdict {
    /// The local exchange owns this. Behave exactly as before.
    Proceed,
    /// Linear owns it, and this mutation can be made there.
    DelegateToLinear { project: String },
    /// Refused, and this is why.
    Refuse(String),
}

/// Decide what to do with a task mutation.
pub fn local_task_verdict(backend: &TaskBackend) -> LocalTaskVerdict {
    match backend {
        TaskBackend::Local => LocalTaskVerdict::Proceed,
        TaskBackend::Linear { project } => LocalTaskVerdict::DelegateToLinear {
            project: project.clone(),
        },
        // Unclear or unreachable ownership refuses BOTH ways: filing into a
        // system we cannot identify is how a task ends up somewhere nobody
        // looks.
        TaskBackend::Misconfigured(reason) => LocalTaskVerdict::Refuse(format!(
            "{reason} Fix the `linear` block in the Aimux config, or remove it to use the local \
             task engine."
        )),
    }
}

/// Why the LOCAL task engine must not act, if it must not.
///
/// `None` means proceed. Anything else is a message naming the owner and what
/// to do, because a refusal a person cannot act on is only slightly better
/// than the silent wrong write it replaced.
pub fn refuse_local_task_mutation(backend: &TaskBackend) -> Option<String> {
    match backend {
        TaskBackend::Local => None,
        TaskBackend::Linear { project } => Some(format!(
            "Tasks for this account live in the Linear project {project}, so the local task \
             engine will not write this one. Writing tasks to Linear is not built yet; until it \
             is, remove the `linear` block from the Aimux config to use the local engine."
        )),
        TaskBackend::Misconfigured(reason) => Some(format!(
            "{reason} Fix the `linear` block in the Aimux config, or remove it to use the local \
             task engine."
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured(token_env: Option<&str>) -> LinearSettings {
        LinearSettings::Configured {
            project: "Aimux".to_owned(),
            token_env: token_env.map(str::to_owned),
        }
    }

    fn readable() -> LinearToken {
        LinearToken::Readable {
            env: "T".to_owned(),
            length: 20,
        }
    }

    /// Every task mutation on a Linear account is delegated now, filing and
    /// moving alike. This used to refuse the moves, when only filing was built.
    #[test]
    fn a_linear_account_delegates_every_task_mutation() {
        let backend = task_backend(&configured(Some("T")), &readable());
        assert_eq!(
            local_task_verdict(&backend),
            LocalTaskVerdict::DelegateToLinear {
                project: "Aimux".to_owned()
            }
        );
    }

    /// A standalone account behaves exactly as before. This is the case that
    /// must not regress.
    #[test]
    fn a_standalone_account_proceeds() {
        let backend = task_backend(&LinearSettings::Absent, &LinearToken::Unnamed);
        assert_eq!(local_task_verdict(&backend), LocalTaskVerdict::Proceed);
    }

    /// Unclear ownership still REFUSES. Filing into, or moving inside, a
    /// system we cannot identify is how a task ends up somewhere nobody looks.
    #[test]
    fn unclear_ownership_refuses_rather_than_delegating() {
        for backend in [
            task_backend(
                &LinearSettings::Unreadable("broken".to_owned()),
                &LinearToken::Unnamed,
            ),
            task_backend(
                &configured(Some("T")),
                &LinearToken::Missing {
                    env: "T".to_owned(),
                },
            ),
        ] {
            let verdict = local_task_verdict(&backend);
            assert!(
                matches!(verdict, LocalTaskVerdict::Refuse(_)),
                "{backend:?} gave {verdict:?}"
            );
        }
    }

    /// The standalone case Sam asked to keep working. No Linear block means
    /// every task verb behaves exactly as it always did.
    #[test]
    fn with_no_linear_account_the_local_engine_still_owns_tasks() {
        let backend = task_backend(&LinearSettings::Absent, &LinearToken::Unnamed);
        assert_eq!(backend, TaskBackend::Local);
        assert_eq!(
            refuse_local_task_mutation(&backend),
            None,
            "a standalone account must not be refused"
        );
    }

    #[test]
    fn a_configured_account_with_a_working_token_hands_tasks_to_linear() {
        let backend = task_backend(&configured(Some("T")), &readable());
        assert_eq!(
            backend,
            TaskBackend::Linear {
                project: "Aimux".to_owned()
            }
        );
        let refusal = refuse_local_task_mutation(&backend).expect("Linear owns it, so refuse");
        assert!(refusal.contains("Aimux"), "{refusal}");
        // The refusal has to say how to get back to a working state, or it is
        // a dead end.
        assert!(refusal.contains("remove the `linear` block"), "{refusal}");
    }

    /// THE GATE THIS MODULE EXISTS FOR. An unreadable block may well name
    /// Linear, so treating it as "no Linear account" would write the task
    /// locally while the config says it belongs elsewhere -- and say nothing.
    #[test]
    fn an_unreadable_block_is_not_a_standalone_account() {
        let backend = task_backend(
            &LinearSettings::Unreadable("linear.project must be a string".to_owned()),
            &LinearToken::Unnamed,
        );
        assert_ne!(
            backend,
            TaskBackend::Local,
            "an unreadable Linear block fell back to the local engine"
        );
        let refusal = refuse_local_task_mutation(&backend).expect("unclear ownership must refuse");
        assert!(
            refusal.contains("linear.project must be a string"),
            "{refusal}"
        );
    }

    /// Chosen but unreachable is also not local. The task belongs to Linear;
    /// the only problem is that nothing can reach it yet, and the refusal says
    /// which half is missing.
    #[test]
    fn a_named_project_with_no_token_refuses_rather_than_writing_locally() {
        for token in [
            LinearToken::Missing {
                env: "T".to_owned(),
            },
            LinearToken::Empty {
                env: "T".to_owned(),
            },
            LinearToken::Unnamed,
        ] {
            let backend = task_backend(&configured(Some("T")), &token);
            assert_ne!(
                backend,
                TaskBackend::Local,
                "{token:?} fell back to the local engine"
            );
            let refusal =
                refuse_local_task_mutation(&backend).expect("{token:?} should have refused");
            assert!(refusal.contains("Aimux"), "{refusal}");
            // The token's own sentence survives, so a person is told whether
            // the variable is unset, empty or unnamed rather than just "no".
            assert!(
                refusal.contains("cannot be reached") || refusal.contains("not set"),
                "{refusal}"
            );
        }
    }

    /// Every refusal names an action. A message that only says "no" leaves
    /// somebody with a broken command and no next step.
    #[test]
    fn every_refusal_says_what_to_do_about_it() {
        for backend in [
            TaskBackend::Linear {
                project: "Aimux".to_owned(),
            },
            TaskBackend::Misconfigured("something is wrong.".to_owned()),
        ] {
            let refusal = refuse_local_task_mutation(&backend)
                .unwrap_or_else(|| panic!("{backend:?} did not refuse"));
            assert!(
                refusal.contains("local task engine") || refusal.contains("local engine"),
                "{backend:?} never mentioned the way back: {refusal}"
            );
        }
    }
}
