use serde_json::Value;

pub fn render_runtime_restart_result(result: &Value) -> String {
    let daemon_status = if bool_at(result, &["daemon", "retained"]) {
        format!(
            "retained pid={}",
            value_label(result.pointer("/daemon/current/pid"))
        )
    } else {
        let current_pid = value_label(result.pointer("/daemon/current/pid"));
        match result.pointer("/daemon/previous/pid") {
            Some(previous_pid) => format!(
                "restarted pid={} -> pid={current_pid}",
                value_label(Some(previous_pid))
            ),
            None => format!("started -> pid={current_pid}"),
        }
    };
    let mut lines = vec![
        "Aimux Restart".to_owned(),
        format!("  daemon: {daemon_status}"),
        format!(
            "  projects: {}",
            number_at(result, &["summary", "projects"])
        ),
        format!(
            "  services ensured: {}",
            number_at(result, &["summary", "servicesEnsured"])
        ),
        format!(
            "  runtime repaired: {}",
            number_at(result, &["summary", "runtimeRepairs"])
        ),
        format!(
            "  dashboards reloaded: {}",
            number_at(result, &["summary", "dashboardsReloaded"])
        ),
        format!(
            "  validation orphans: {} processes, {} tmux sessions, {} tmux windows",
            number_at(result, &["summary", "orphanProcessesCleaned"]),
            number_at(result, &["summary", "orphanTmuxSessionsCleaned"]),
            number_at(result, &["summary", "orphanTmuxWindowsCleaned"])
        ),
        format!(
            "  failures: {}",
            number_at(result, &["summary", "failures"])
        ),
    ];

    if number_at(result, &["summary", "runtimeRebuildRequired"]) > 0 {
        lines.push(String::new());
        lines.push("Runtime repaired:".into());
        for project in result["projects"].as_array().into_iter().flatten() {
            if bool_at(project, &["runtimeRebuildRequired"]) {
                lines.push(format!("  {}", string_at(project, &["projectRoot"])));
            }
        }
    }

    for project in result["projects"].as_array().into_iter().flatten() {
        lines.push(String::new());
        lines.push(format!("Project: {}", string_at(project, &["projectRoot"])));
        lines.push(step_line(project, "runtime"));
        lines.push(step_line(project, "service"));
        lines.push(dashboard_line(project));
    }

    if number_at(result, &["summary", "failures"]) > 0 {
        lines.push(String::new());
        if string_at(result, &["verification", "status"]) == "failed" {
            let error = string_at(result, &["verification", "error"]);
            lines.push(format!(
                "Post-restart verification failed: {}",
                if error.is_empty() {
                    "unknown error"
                } else {
                    &error
                }
            ));
            if !result
                .pointer("/verification/after")
                .is_none_or(Value::is_null)
            {
                lines.push("After restart:".into());
                lines.push(render_runtime_coherence_report(
                    &result["verification"]["after"],
                ));
            }
            lines.push(String::new());
        }
        lines.push("Before restart:".into());
        lines.push(render_runtime_coherence_report(&result["before"]));
    }

    lines.join("\n")
}

fn step_line(project: &Value, key: &str) -> String {
    let status = string_at(project, &[key, "status"]);
    let error = string_at(project, &[key, "error"]);
    if error.is_empty() {
        format!("  {key}: {status}")
    } else {
        format!("  {key}: {status} ({error})")
    }
}

fn dashboard_line(project: &Value) -> String {
    let dashboard = &project["dashboard"];
    let status = string_at(dashboard, &["status"]);
    let target = if dashboard
        .pointer("/target")
        .is_some_and(|value| !value.is_null())
    {
        format!(
            " {}:{}",
            string_at(dashboard, &["sessionName"]),
            string_at(dashboard, &["target", "windowId"])
        )
    } else {
        String::new()
    };
    let error = string_at(dashboard, &["error"]);
    if error.is_empty() {
        format!("  dashboard: {status}{target}")
    } else {
        format!("  dashboard: {status}{target} ({error})")
    }
}

fn render_runtime_coherence_report(report: &Value) -> String {
    let mut lines = vec![
        "Aimux Versions".to_owned(),
        format!("  cli version: {}", stringish_at(report, &["cliVersion"])),
        format!(
            "  build profile: {}",
            stringish_at(report, &["buildProfile"])
        ),
        cli_launcher_line(&report["cliLaunch"]),
        format!(
            "  cli current entry: {}",
            stringish_at(report, &["cliLaunch", "currentEntryPath"])
        ),
        format!(
            "  cli stable shim: {}",
            stringish_at(report, &["cliLaunch", "stableShimPath"])
        ),
        format!(
            "  expected project service: {}",
            format_manifest(report.pointer("/expected/projectService"))
        ),
        format!(
            "  expected runtime owner: {}",
            stringish_at(report, &["expected", "runtimeOwner"])
        ),
        format!(
            "  expected tmux runtime contract: {}",
            stringish_at(report, &["expected", "runtimeContract"])
        ),
        daemon_line(&report["daemon"]),
        "    daemon process: (unknown)".to_owned(),
        format!(
            "  daemon projects: {}",
            number_at(report, &["daemon", "projectCount"])
        ),
        format!(
            "  tmux: {}",
            if bool_at(report, &["tmux", "available"]) {
                let version = stringish_at(report, &["tmux", "version"]);
                if version.is_empty() {
                    "available".into()
                } else {
                    version
                }
            } else {
                "unavailable".into()
            }
        ),
        format!(
            "  tmux sessions: {}",
            number_at(report, &["tmux", "sessionCount"])
        ),
        format!(
            "  projects: {} ({} ok, {} need restart, {} need runtime rebuild)",
            number_at(report, &["summary", "projects"]),
            number_at(report, &["summary", "ok"]),
            number_at(report, &["summary", "needsRestart"]),
            number_at(report, &["summary", "runtimeRebuildRequired"])
        ),
    ];
    for project in report["projects"].as_array().into_iter().flatten() {
        lines.push(String::new());
        lines.push(format!(
            "Project {}: {}",
            stringish_at(project, &["projectRoot"]),
            stringish_at(project, &["status"])
        ));
    }
    lines.join("\n")
}

fn cli_launcher_line(value: &Value) -> String {
    let source = stringish_at(value, &["source"]);
    let command = stringish_at(value, &["command"]);
    let args = value
        .get("args")
        .and_then(Value::as_array)
        .map(|args| {
            args.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    let suffix = if args.is_empty() {
        command
    } else {
        format!("{command} {args}")
    };
    format!("cli launcher: {source} {suffix}")
}

fn daemon_line(value: &Value) -> String {
    if !bool_at(value, &["running"]) {
        return "  daemon: stopped".into();
    }
    format!(
        "  daemon: running pid={}",
        value_label(value.pointer("/info/pid"))
    )
}

fn format_manifest(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return "api=undefined build=undefined".into();
    };
    format!(
        "api={} build={}",
        stringish_at(value, &["apiVersion"]),
        stringish_at(value, &["buildStamp"])
    )
}

fn bool_at(value: &Value, path: &[&str]) -> bool {
    pointer(value, path).and_then(Value::as_bool) == Some(true)
}

fn number_at(value: &Value, path: &[&str]) -> i64 {
    pointer(value, path).and_then(Value::as_i64).unwrap_or(0)
}

fn string_at(value: &Value, path: &[&str]) -> String {
    pointer(value, path)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn stringish_at(value: &Value, path: &[&str]) -> String {
    value_label(pointer(value, path))
}

fn value_label(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Null) | None => "undefined".into(),
        Some(value) => value.to_string(),
    }
}

fn pointer<'a>(mut value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    for segment in path {
        value = value.get(*segment)?;
    }
    Some(value)
}
