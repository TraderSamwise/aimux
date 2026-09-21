use crate::jobs::{
    JobEventInput, JobRecord, JobScope, JobSpec, JobStatus, JobStore, JobStoreError, JobTmuxTarget,
    validate_job_id,
};
use crate::lifecycle_orphans::{kill_pid, wait_for_pid_exit_with};
use crate::managed_launch_env::{
    build_managed_job_env, wrap_command_with_managed_launch_env_extra,
};
use crate::paths::PathResolver;
use crate::tmux::{
    PanePipeFileOptions, TmuxCommandSpec, TmuxRuntimeManager, TmuxTarget, packed_argv_bytes,
    project_session, respawn_window_argv,
};
use serde_json::json;
use sha1::{Digest, Sha1};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::Duration;

pub const JOB_TMUX_ARGV_MAX_BYTES: usize = 16_350;
const JOB_CANCEL_TERM_GRACE_MS: u64 = 2_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobLaunchPlan {
    pub session_name: String,
    pub cwd: String,
    pub command: String,
    pub args: Vec<String>,
    pub argv_bytes: usize,
    pub tap_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCancelReport {
    pub signal: String,
    pub pid: Option<i32>,
}

pub trait JobTmuxRuntime {
    fn ensure_project_session(
        &mut self,
        project_root: &Path,
    ) -> std::result::Result<String, String>;
    fn ensure_global_session(
        &mut self,
        session_name: &str,
        cwd: &Path,
    ) -> std::result::Result<String, String>;
    fn create_window(
        &mut self,
        session_name: &str,
        name: &str,
        cwd: &str,
        command: &str,
        args: &[String],
    ) -> std::result::Result<TmuxTarget, String>;
    fn set_window_metadata(
        &mut self,
        window_id: &str,
        metadata: &serde_json::Value,
    ) -> std::result::Result<(), String>;
    fn set_window_tool(&mut self, window_id: &str, tool: &str) -> std::result::Result<(), String>;
    fn pipe_target_to_file(
        &mut self,
        target: &TmuxTarget,
        file_path: &str,
    ) -> std::result::Result<(), String>;
    fn is_pane_piped(&mut self, target: &TmuxTarget) -> std::result::Result<bool, String>;
    fn respawn_window(
        &mut self,
        target: &TmuxTarget,
        spec: &TmuxCommandSpec,
    ) -> std::result::Result<(), String>;
    fn kill_window(&mut self, target: &TmuxTarget) -> std::result::Result<(), String>;
    fn live_window_ids(
        &mut self,
    ) -> std::result::Result<std::collections::BTreeSet<String>, String>;
    fn pane_pid(&mut self, target: &TmuxTarget) -> std::result::Result<Option<i32>, String>;
}

impl JobTmuxRuntime for TmuxRuntimeManager {
    fn ensure_project_session(
        &mut self,
        project_root: &Path,
    ) -> std::result::Result<String, String> {
        self.ensure_project_session(project_root, None, None)
            .map(|session| session.session_name)
    }

    fn ensure_global_session(
        &mut self,
        session_name: &str,
        cwd: &Path,
    ) -> std::result::Result<String, String> {
        self.ensure_named_idle_session(session_name, cwd)
    }

    fn create_window(
        &mut self,
        session_name: &str,
        name: &str,
        cwd: &str,
        command: &str,
        args: &[String],
    ) -> std::result::Result<TmuxTarget, String> {
        self.create_window(session_name, name, cwd, command, args, true)
    }

    fn set_window_metadata(
        &mut self,
        window_id: &str,
        metadata: &serde_json::Value,
    ) -> std::result::Result<(), String> {
        self.set_window_metadata(window_id, metadata)
    }

    fn set_window_tool(&mut self, window_id: &str, tool: &str) -> std::result::Result<(), String> {
        self.set_window_option(window_id, "@aimux-tool", tool)
    }

    fn pipe_target_to_file(
        &mut self,
        target: &TmuxTarget,
        file_path: &str,
    ) -> std::result::Result<(), String> {
        self.pipe_target_to_file(
            target,
            file_path,
            PanePipeFileOptions {
                only_if_not_piped: true,
                ownership: None,
            },
        )
    }

    fn is_pane_piped(&mut self, target: &TmuxTarget) -> std::result::Result<bool, String> {
        Ok(self.is_pane_piped(target))
    }

    fn respawn_window(
        &mut self,
        target: &TmuxTarget,
        spec: &TmuxCommandSpec,
    ) -> std::result::Result<(), String> {
        self.respawn_window(target, spec)
    }

    fn kill_window(&mut self, target: &TmuxTarget) -> std::result::Result<(), String> {
        self.kill_window(target)
    }

    fn live_window_ids(
        &mut self,
    ) -> std::result::Result<std::collections::BTreeSet<String>, String> {
        self.try_live_window_ids()
    }

    fn pane_pid(&mut self, target: &TmuxTarget) -> std::result::Result<Option<i32>, String> {
        self.pane_pid(target)
    }
}

pub fn global_jobs_session_name(resolver: &PathResolver) -> String {
    let home_path = resolver.global_aimux_dir();
    let home = home_path.to_string_lossy();
    let digest = Sha1::digest(home.as_bytes());
    format!("aimux-jobs-{:x}", digest)[..21].to_owned()
}

pub fn launch_job_in_tmux(
    store: &JobStore,
    resolver: &mut PathResolver,
    tmux: &mut impl JobTmuxRuntime,
    record: &JobRecord,
    spec: &JobSpec,
) -> Result<JobRecord, JobStoreError> {
    let plan = build_launch_plan(store, resolver, record, spec)?;
    if plan.argv_bytes > JOB_TMUX_ARGV_MAX_BYTES {
        return Err(JobStoreError::InvalidSpec(format!(
            "job tmux argv is {} bytes, over cap {JOB_TMUX_ARGV_MAX_BYTES}",
            plan.argv_bytes
        )));
    }
    if let Some(parent) = plan.tap_path.parent() {
        fs::create_dir_all(parent).map_err(|error| JobStoreError::StoreUnavailable {
            path: parent.to_path_buf(),
            error: error.to_string(),
        })?;
    }
    match &spec.scope {
        JobScope::Global => {
            tmux.ensure_global_session(&plan.session_name, Path::new(&plan.cwd))
                .map_err(|error| JobStoreError::StoreUnavailable {
                    path: plan.tap_path.clone(),
                    error,
                })?;
        }
        JobScope::Project { .. } | JobScope::Worktree { .. } => {
            tmux.ensure_project_session(Path::new(&plan.cwd))
                .map_err(|error| JobStoreError::StoreUnavailable {
                    path: plan.tap_path.clone(),
                    error,
                })?;
        }
    }
    let target = tmux
        .create_window(
            &plan.session_name,
            &job_window_name(record),
            &plan.cwd,
            "tail",
            &["-f".to_owned(), "/dev/null".to_owned()],
        )
        .map_err(|error| JobStoreError::StoreUnavailable {
            path: plan.tap_path.clone(),
            error,
        })?;
    let metadata = json!({
        "kind": "job",
        "jobId": record.id,
        "skill": record.skill,
        "tool": record.tool,
    });
    tmux.set_window_metadata(&target.window_id, &metadata)
        .map_err(|error| JobStoreError::StoreUnavailable {
            path: plan.tap_path.clone(),
            error,
        })?;
    tmux.set_window_tool(&target.window_id, "job")
        .map_err(|error| JobStoreError::StoreUnavailable {
            path: plan.tap_path.clone(),
            error,
        })?;
    if tmux
        .is_pane_piped(&target)
        .map_err(|error| JobStoreError::StoreUnavailable {
            path: plan.tap_path.clone(),
            error,
        })?
    {
        return Err(JobStoreError::StoreUnavailable {
            path: plan.tap_path.clone(),
            error: format!(
                "job pane {} is already piped; refusing to lose job output",
                target.window_id
            ),
        });
    }
    tmux.pipe_target_to_file(&target, &plan.tap_path.to_string_lossy())
        .map_err(|error| JobStoreError::StoreUnavailable {
            path: plan.tap_path.clone(),
            error,
        })?;
    let running = store.mark_running(
        &record.id,
        JobTmuxTarget {
            session_name: target.session_name.clone(),
            window_id: target.window_id.clone(),
            window_index: target.window_index,
            window_name: target.window_name.clone(),
        },
        plan.tap_path.to_string_lossy(),
    )?;
    let spec = TmuxCommandSpec {
        cwd: plan.cwd,
        command: plan.command,
        args: plan.args,
    };
    if let Err(error) = tmux.respawn_window(&target, &spec) {
        let _ = tmux.kill_window(&target);
        let _ = store.finish(
            &running.id,
            JobStatus::Failed,
            None,
            format!("failed to launch job command: {error}"),
            None,
        );
        return Err(JobStoreError::StoreUnavailable {
            path: plan.tap_path,
            error,
        });
    }
    store.load(&running.id)
}

pub fn build_launch_plan(
    store: &JobStore,
    resolver: &mut PathResolver,
    record: &JobRecord,
    spec: &JobSpec,
) -> Result<JobLaunchPlan, JobStoreError> {
    spec.tool
        .as_deref()
        .map(str::trim)
        .filter(|tool| !tool.is_empty())
        .ok_or_else(|| JobStoreError::InvalidSpec("job tool is required".to_owned()))?;
    let cwd = job_cwd(resolver, spec)?;
    let session_name = match &spec.scope {
        JobScope::Global => global_jobs_session_name(resolver),
        JobScope::Project { .. } | JobScope::Worktree { .. } => {
            tmux_session_for_cwd(resolver, &cwd)
        }
    };
    let exe = std::env::current_exe().map_err(|error| JobStoreError::StoreUnavailable {
        path: PathBuf::from("current_exe"),
        error: error.to_string(),
    })?;
    let args = vec!["__job-exec-internal".to_owned(), record.id.clone()];
    let extra_env = [("AIMUX_JOB_ID".to_owned(), record.id.clone())];
    let (command, args) =
        wrap_command_with_managed_launch_env_extra(exe.to_string_lossy(), args, extra_env);
    let argv = respawn_window_argv(
        "@job-argv-budget",
        &TmuxCommandSpec {
            cwd: cwd.to_string_lossy().into_owned(),
            command: command.clone(),
            args: args.clone(),
        },
    );
    let argv_bytes = packed_argv_bytes(&argv);
    Ok(JobLaunchPlan {
        session_name,
        cwd: cwd.to_string_lossy().into_owned(),
        command,
        args,
        argv_bytes,
        tap_path: store.output_tap_path(&record.id),
    })
}

pub fn capture_job_output_once(
    store: &JobStore,
    record: &JobRecord,
) -> Result<JobRecord, JobStoreError> {
    let Some(path) = record.output_tap_path.as_ref().map(PathBuf::from) else {
        return Ok(record.clone());
    };
    let mut file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(record.clone()),
        Err(error) => {
            return Err(JobStoreError::StoreUnavailable {
                path,
                error: error.to_string(),
            });
        }
    };
    file.seek(SeekFrom::Start(record.output_offset))
        .map_err(|error| JobStoreError::StoreUnavailable {
            path: path.clone(),
            error: error.to_string(),
        })?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| JobStoreError::StoreUnavailable {
            path: path.clone(),
            error: error.to_string(),
        })?;
    if bytes.is_empty() {
        return Ok(record.clone());
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    store.append_event(
        &record.id,
        JobEventInput {
            kind: "output".to_owned(),
            data: json!({ "text": text }),
        },
    )?;
    store.set_output_offset(&record.id, record.output_offset + bytes.len() as u64)
}

pub fn reconcile_running_jobs(
    store: &JobStore,
    tmux: &mut impl JobTmuxRuntime,
) -> Result<usize, JobStoreError> {
    let mut changed = 0;
    let records = store.list(crate::jobs::JobListFilter {
        scope: None,
        status: Some(JobStatus::Running),
    })?;
    if records.is_empty() {
        return Ok(0);
    }
    let live_windows = tmux
        .live_window_ids()
        .map_err(|error| JobStoreError::StoreUnavailable {
            path: store.root().to_path_buf(),
            error,
        })?;
    for record in records {
        let refreshed = capture_job_output_once(store, &record)?;
        let Some(target) = refreshed.tmux_target.as_ref() else {
            store.finish(
                &refreshed.id,
                JobStatus::Failed,
                None,
                "running job has no tmux target",
                None,
            )?;
            changed += 1;
            continue;
        };
        if !live_windows.contains(&target.window_id) {
            let target = TmuxTarget {
                session_name: target.session_name.clone(),
                window_id: target.window_id.clone(),
                window_index: target.window_index,
                window_name: target.window_name.clone(),
                pane_dead: None,
            };
            let kill_result = tmux.kill_window(&target);
            let reason = match kill_result {
                Ok(()) => "tmux window disappeared before job reported exit".to_owned(),
                Err(error) => format!(
                    "tmux window disappeared before job reported exit; reap attempted and failed: {error}"
                ),
            };
            store.finish(&refreshed.id, JobStatus::Failed, None, reason, None)?;
            changed += 1;
        }
    }
    Ok(changed)
}

pub fn cancel_running_job(
    store: &JobStore,
    tmux: &mut impl JobTmuxRuntime,
    record: &JobRecord,
) -> Result<JobCancelReport, JobStoreError> {
    let Some(target) = record.tmux_target.as_ref() else {
        let record = store.finish(
            &record.id,
            JobStatus::Cancelled,
            None,
            "cancelled running job without tmux target",
            None,
        )?;
        return Ok(JobCancelReport {
            signal: record.cancel_signal.unwrap_or_else(|| "none".to_owned()),
            pid: None,
        });
    };
    let target = TmuxTarget {
        session_name: target.session_name.clone(),
        window_id: target.window_id.clone(),
        window_index: target.window_index,
        window_name: target.window_name.clone(),
        pane_dead: None,
    };
    let pid = tmux
        .pane_pid(&target)
        .map_err(|error| JobStoreError::StoreUnavailable {
            path: store.root().to_path_buf(),
            error,
        })?;
    let Some(pid) = pid else {
        store.finish(
            &record.id,
            JobStatus::Cancelled,
            None,
            "cancelled running job with no live pane pid",
            Some("none".to_owned()),
        )?;
        return Ok(JobCancelReport {
            signal: "none".to_owned(),
            pid: None,
        });
    };
    kill_process_group_for_pid(pid, "SIGTERM").map_err(|error| {
        JobStoreError::StoreUnavailable {
            path: store.root().to_path_buf(),
            error,
        }
    })?;
    let signal = if wait_for_pid_exit_with(pid, Duration::from_millis(JOB_CANCEL_TERM_GRACE_MS)) {
        "SIGTERM"
    } else {
        kill_process_group_for_pid(pid, "SIGKILL").map_err(|error| {
            JobStoreError::StoreUnavailable {
                path: store.root().to_path_buf(),
                error,
            }
        })?;
        if !wait_for_pid_exit_with(pid, Duration::from_millis(500)) {
            kill_pid(pid, "SIGKILL").map_err(|error| JobStoreError::StoreUnavailable {
                path: store.root().to_path_buf(),
                error,
            })?;
        }
        "SIGKILL"
    };
    store.finish(
        &record.id,
        JobStatus::Cancelled,
        None,
        format!("cancelled by {signal}"),
        Some(signal.to_owned()),
    )?;
    Ok(JobCancelReport {
        signal: signal.to_owned(),
        pid: Some(pid),
    })
}

pub fn run_job_exec(id: &str) -> Result<ExitCode, String> {
    let store = JobStore::from_env();
    run_job_exec_with_store(&store, id)
}

fn run_job_exec_with_store(store: &JobStore, id: &str) -> Result<ExitCode, String> {
    validate_job_id(id).map_err(|error| error.to_string())?;
    let record = store.load(id).map_err(|error| error.to_string())?;
    if record.status != JobStatus::Running
        || record.tmux_target.is_none()
        || record.output_tap_path.is_none()
    {
        return Err(format!(
            "job {id} is not launchable: status={:?}, tmuxTarget={}, outputTapPath={}",
            record.status,
            record.tmux_target.is_some(),
            record.output_tap_path.is_some()
        ));
    }
    let material = store.load_material(id).map_err(|error| error.to_string())?;
    let tool = record
        .tool
        .as_deref()
        .map(str::trim)
        .filter(|tool| !tool.is_empty())
        .ok_or_else(|| "job tool is required".to_owned())?;
    let prompt = job_prompt(&record.skill, &material.args);
    let filtered_env = build_managed_job_env(material.env);
    let status = Command::new(tool)
        .arg(prompt)
        .envs(filtered_env)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|error| format!("failed to execute job tool {tool}: {error}"))?;
    let exit_code = status.code();
    capture_job_output_once(store, &store.load(id).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let terminal = if status.success() {
        JobStatus::Succeeded
    } else {
        JobStatus::Failed
    };
    let reason = exit_code.map_or_else(
        || "tool terminated by signal".to_owned(),
        |code| format!("tool exited with {code}"),
    );
    store
        .finish(id, terminal, exit_code, reason, None)
        .map_err(|error| error.to_string())?;
    Ok(ExitCode::from(exit_code.unwrap_or(1) as u8))
}

fn kill_process_group_for_pid(pid: i32, signal: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        let pgid = unsafe { libc::getpgid(pid) };
        if pgid > 0 {
            return kill_pid(-pgid, signal);
        }
    }
    kill_pid(pid, signal)
}

fn job_cwd(resolver: &PathResolver, spec: &JobSpec) -> Result<PathBuf, JobStoreError> {
    if let Some(cwd) = spec.cwd.as_ref().filter(|cwd| !cwd.trim().is_empty()) {
        return Ok(PathBuf::from(cwd));
    }
    match &spec.scope {
        JobScope::Global => {
            std::env::current_dir().map_err(|error| JobStoreError::StoreUnavailable {
                path: PathBuf::from("."),
                error: error.to_string(),
            })
        }
        JobScope::Project { project_id } | JobScope::Worktree { project_id, .. } => resolver
            .load_registry()
            .map_err(|error| JobStoreError::StoreUnavailable {
                path: resolver.projects_registry_path(),
                error: error.to_string(),
            })?
            .projects
            .into_iter()
            .find(|project| project.id == *project_id)
            .map(|project| PathBuf::from(project.repo_root))
            .ok_or_else(|| JobStoreError::InvalidSpec(format!("unknown project id {project_id}"))),
    }
}

fn tmux_session_for_cwd(resolver: &mut PathResolver, cwd: &Path) -> String {
    let _ = resolver;
    project_session(cwd, "aimux").session_name
}

fn job_window_name(record: &JobRecord) -> String {
    let suffix = record.id.trim_start_matches("job-");
    format!("job-{}", &suffix[..8.min(suffix.len())])
}

fn job_prompt(skill: &str, args: &[String]) -> String {
    let mut prompt = format!("/{skill}");
    if !args.is_empty() {
        prompt.push(' ');
        prompt.push_str(&args.join(" "));
    }
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::{CreateOrJoin, JobListFilter};
    use std::collections::BTreeSet;
    #[cfg(unix)]
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    #[derive(Default)]
    struct FakeTmux {
        live: BTreeSet<String>,
        next_pid: Option<i32>,
        metadata: Vec<serde_json::Value>,
        tools: Vec<String>,
        piped: Vec<String>,
        created_args: Vec<String>,
        respawned_args: Vec<String>,
        killed_windows: Vec<String>,
        already_piped: bool,
        live_queries: usize,
    }

    impl JobTmuxRuntime for FakeTmux {
        fn ensure_project_session(
            &mut self,
            project_root: &Path,
        ) -> std::result::Result<String, String> {
            Ok(project_session(project_root, "aimux").session_name)
        }

        fn ensure_global_session(
            &mut self,
            session_name: &str,
            _cwd: &Path,
        ) -> std::result::Result<String, String> {
            Ok(session_name.to_owned())
        }

        fn create_window(
            &mut self,
            session_name: &str,
            name: &str,
            _cwd: &str,
            command: &str,
            args: &[String],
        ) -> std::result::Result<TmuxTarget, String> {
            self.created_args = std::iter::once(command.to_owned())
                .chain(args.iter().cloned())
                .collect();
            let target = TmuxTarget {
                session_name: session_name.to_owned(),
                window_id: "@job".to_owned(),
                window_index: 3,
                window_name: name.to_owned(),
                pane_dead: None,
            };
            self.live.insert(target.window_id.clone());
            Ok(target)
        }

        fn set_window_metadata(
            &mut self,
            _window_id: &str,
            metadata: &serde_json::Value,
        ) -> std::result::Result<(), String> {
            self.metadata.push(metadata.clone());
            Ok(())
        }

        fn set_window_tool(
            &mut self,
            _window_id: &str,
            tool: &str,
        ) -> std::result::Result<(), String> {
            self.tools.push(tool.to_owned());
            Ok(())
        }

        fn pipe_target_to_file(
            &mut self,
            _target: &TmuxTarget,
            file_path: &str,
        ) -> std::result::Result<(), String> {
            self.piped.push(file_path.to_owned());
            Ok(())
        }

        fn is_pane_piped(&mut self, _target: &TmuxTarget) -> std::result::Result<bool, String> {
            Ok(self.already_piped)
        }

        fn respawn_window(
            &mut self,
            _target: &TmuxTarget,
            spec: &TmuxCommandSpec,
        ) -> std::result::Result<(), String> {
            self.respawned_args = std::iter::once(spec.command.clone())
                .chain(spec.args.iter().cloned())
                .collect();
            Ok(())
        }

        fn kill_window(&mut self, target: &TmuxTarget) -> std::result::Result<(), String> {
            self.killed_windows.push(target.window_id.clone());
            self.live.remove(&target.window_id);
            Ok(())
        }

        fn live_window_ids(&mut self) -> std::result::Result<BTreeSet<String>, String> {
            self.live_queries += 1;
            Ok(self.live.clone())
        }

        fn pane_pid(&mut self, _target: &TmuxTarget) -> std::result::Result<Option<i32>, String> {
            Ok(self.next_pid)
        }
    }

    fn store(label: &str) -> JobStore {
        JobStore::new(
            std::env::temp_dir().join(format!("aimux-job-runner-{label}-{}", std::process::id())),
        )
    }

    fn spec(args: Vec<String>) -> JobSpec {
        JobSpec {
            scope: JobScope::Global,
            skill: "review-pr".to_owned(),
            tool: Some("/bin/true".to_owned()),
            args,
            cwd: Some(std::env::temp_dir().to_string_lossy().into_owned()),
            env: Default::default(),
        }
    }

    #[test]
    fn launch_passes_only_job_id_through_tmux_and_tags_window() {
        let store = store("launch-spill");
        let mut resolver = PathResolver::new(std::env::temp_dir(), store.root(), None);
        let huge = "x".repeat(JOB_TMUX_ARGV_MAX_BYTES * 2);
        let mut spec = spec(vec![huge.clone()]);
        spec.env.insert("AIMUX_HUGE".to_owned(), huge.clone());
        spec.env
            .insert("PATH".to_owned(), "/tmp/attacker".to_owned());
        spec.env
            .insert("LD_PRELOAD".to_owned(), "token-secret".to_owned());
        let (record, outcome) = store.create_or_join(&spec).expect("record");
        assert_eq!(outcome, CreateOrJoin::Created);
        let mut tmux = FakeTmux::default();
        let running =
            launch_job_in_tmux(&store, &mut resolver, &mut tmux, &record, &spec).expect("launch");
        assert_eq!(running.status, JobStatus::Running);
        assert_eq!(tmux.created_args, vec!["tail", "-f", "/dev/null"]);
        assert!(tmux.respawned_args.iter().any(|arg| arg == &record.id));
        assert!(!tmux.created_args.iter().any(|arg| arg.contains(&huge)));
        assert!(!tmux.respawned_args.iter().any(|arg| arg.contains(&huge)));
        assert!(
            !tmux
                .respawned_args
                .iter()
                .any(|arg| arg.contains("/tmp/attacker"))
        );
        assert!(
            !tmux
                .respawned_args
                .iter()
                .any(|arg| arg.contains("LD_PRELOAD") || arg.contains("token-secret"))
        );
        let plan = build_launch_plan(&store, &mut resolver, &record, &spec).expect("plan");
        assert!(plan.argv_bytes <= JOB_TMUX_ARGV_MAX_BYTES);
        assert_eq!(tmux.metadata[0]["kind"], "job");
        assert_eq!(tmux.metadata[0]["jobId"], record.id);
        assert_eq!(tmux.tools, vec!["job"]);
        assert!(tmux.piped[0].ends_with("output.tap"));
    }

    #[test]
    fn launch_refuses_when_existing_pipe_would_lose_job_output() {
        let store = store("argv-cap");
        let mut resolver = PathResolver::new(std::env::temp_dir(), store.root(), None);
        let spec = spec(Vec::new());
        let (record, _) = store.create_or_join(&spec).expect("record");
        let mut tmux = FakeTmux {
            already_piped: true,
            ..FakeTmux::default()
        };
        let error = launch_job_in_tmux(&store, &mut resolver, &mut tmux, &record, &spec)
            .expect_err("existing pipe must not be silently stolen");
        assert!(error.to_string().contains("already piped"));
        assert!(tmux.piped.is_empty());
        assert!(tmux.respawned_args.is_empty());
    }

    #[test]
    fn internal_exec_rejects_path_traversal_and_terminal_jobs() {
        let store = store("exec-guard");
        let spec = spec(Vec::new());
        let (record, _) = store.create_or_join(&spec).expect("record");
        assert!(
            run_job_exec_with_store(&store, "../../../x")
                .expect_err("invalid ids must not reach store paths")
                .contains("invalid characters")
        );
        let running = store
            .mark_running(
                &record.id,
                JobTmuxTarget {
                    session_name: "aimux-jobs".to_owned(),
                    window_id: "@exec".to_owned(),
                    window_index: 1,
                    window_name: "job".to_owned(),
                },
                store.output_tap_path(&record.id).to_string_lossy(),
            )
            .expect("running");
        store
            .finish(
                &running.id,
                JobStatus::Succeeded,
                Some(0),
                "already complete",
                None,
            )
            .expect("finish");
        let error = run_job_exec_with_store(&store, &running.id)
            .expect_err("terminal jobs must not re-exec");
        assert!(error.contains("not launchable"), "{error}");
    }

    #[test]
    fn output_capture_uses_offset_without_duplicates() {
        let store = store("output-offset");
        let spec = spec(Vec::new());
        let (record, _) = store.create_or_join(&spec).expect("record");
        let tap = store.output_tap_path(&record.id);
        fs::create_dir_all(tap.parent().unwrap()).expect("tap parent");
        let running = store
            .mark_running(
                &record.id,
                JobTmuxTarget {
                    session_name: "aimux-jobs".to_owned(),
                    window_id: "@1".to_owned(),
                    window_index: 1,
                    window_name: "job".to_owned(),
                },
                tap.to_string_lossy(),
            )
            .expect("running");
        fs::write(&tap, "first\n").expect("write tap");
        let after_first = capture_job_output_once(&store, &running).expect("capture first");
        assert_eq!(store.read_events_from(&record.id, 0).unwrap().len(), 1);
        let after_duplicate = capture_job_output_once(&store, &after_first).expect("capture none");
        assert_eq!(store.read_events_from(&record.id, 0).unwrap().len(), 1);
        fs::write(&tap, "first\nsecond\n").expect("append-ish tap");
        capture_job_output_once(&store, &after_duplicate).expect("capture second");
        let events = store.read_events_from(&record.id, 0).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].seq, 0);
        assert_eq!(events[1].seq, 1);
        assert_eq!(events[1].data["text"], "second\n");
    }

    #[test]
    fn reconcile_marks_running_job_terminal_when_window_is_gone() {
        let store = store("reconcile-gone");
        let spec = spec(Vec::new());
        let (record, _) = store.create_or_join(&spec).expect("record");
        let tap = store.output_tap_path(&record.id);
        let running = store
            .mark_running(
                &record.id,
                JobTmuxTarget {
                    session_name: "aimux-jobs".to_owned(),
                    window_id: "@missing".to_owned(),
                    window_index: 1,
                    window_name: "job".to_owned(),
                },
                tap.to_string_lossy(),
            )
            .expect("running");
        assert_eq!(running.status, JobStatus::Running);
        let mut tmux = FakeTmux::default();
        assert_eq!(reconcile_running_jobs(&store, &mut tmux).unwrap(), 1);
        assert_eq!(tmux.killed_windows, vec!["@missing"]);
        let finished = store.load(&record.id).unwrap();
        assert_eq!(finished.status, JobStatus::Failed);
        assert!(
            finished
                .terminal_reason
                .unwrap()
                .contains("tmux window disappeared")
        );
    }

    #[test]
    fn reconcile_idle_store_does_not_query_tmux() {
        let store = store("reconcile-idle");
        let mut tmux = FakeTmux::default();
        assert_eq!(reconcile_running_jobs(&store, &mut tmux).unwrap(), 0);
        assert_eq!(tmux.live_queries, 0);
    }

    #[test]
    fn cancel_running_job_terminates_process_and_reports_signal() {
        let store = store("cancel");
        let spec = spec(Vec::new());
        let (record, _) = store.create_or_join(&spec).expect("record");
        let running = store
            .mark_running(
                &record.id,
                JobTmuxTarget {
                    session_name: "aimux-jobs".to_owned(),
                    window_id: "@cancel".to_owned(),
                    window_index: 1,
                    window_name: "job".to_owned(),
                },
                store.output_tap_path(&record.id).to_string_lossy(),
            )
            .expect("running");
        let pid_file = store.root().join("child.pid");
        let mut child = {
            let mut command = Command::new("sh");
            command
                .arg("-c")
                .arg(format!("sleep 30 & echo $! > {}; wait", pid_file.display()));
            #[cfg(unix)]
            command.process_group(0);
            command.spawn().expect("wrapper")
        };
        let child_pid = wait_for_pid_file(&pid_file);
        let mut tmux = FakeTmux {
            next_pid: Some(child.id() as i32),
            ..FakeTmux::default()
        };
        let report = cancel_running_job(&store, &mut tmux, &running).expect("cancel");
        let _ = child.wait();
        assert_eq!(report.signal, "SIGTERM");
        assert!(!pid_is_alive(child_pid), "job child process was orphaned");
        let record = store.load(&record.id).unwrap();
        assert_eq!(record.status, JobStatus::Cancelled);
        assert_eq!(record.cancel_signal.as_deref(), Some("SIGTERM"));
    }

    fn wait_for_pid_file(path: &Path) -> i32 {
        for _ in 0..50 {
            if let Ok(raw) = fs::read_to_string(path)
                && let Ok(pid) = raw.trim().parse::<i32>()
            {
                return pid;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("child pid file was not written");
    }

    fn pid_is_alive(pid: i32) -> bool {
        #[cfg(unix)]
        {
            unsafe { libc::kill(pid, 0) == 0 }
        }
        #[cfg(not(unix))]
        {
            let _ = pid;
            false
        }
    }

    #[test]
    fn live_window_reconcile_keeps_running_job_when_window_exists() {
        let store = store("reconcile-live");
        let spec = spec(Vec::new());
        let (record, _) = store.create_or_join(&spec).expect("record");
        store
            .mark_running(
                &record.id,
                JobTmuxTarget {
                    session_name: "aimux-jobs".to_owned(),
                    window_id: "@live".to_owned(),
                    window_index: 1,
                    window_name: "job".to_owned(),
                },
                store.output_tap_path(&record.id).to_string_lossy(),
            )
            .expect("running");
        let mut tmux = FakeTmux {
            live: BTreeSet::from(["@live".to_owned()]),
            ..FakeTmux::default()
        };
        assert_eq!(reconcile_running_jobs(&store, &mut tmux).unwrap(), 0);
        assert_eq!(
            store
                .list(JobListFilter {
                    scope: None,
                    status: Some(JobStatus::Running)
                })
                .unwrap()
                .len(),
            1
        );
    }
}
