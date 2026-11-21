//! Whether Linear is configured for this account, and which project it names.
//!
//! Sam's rule: the primitive task engine works standalone, and Linear REPLACES
//! it once configured. So the question this module answers is not "is Linear
//! available" but "has somebody chosen it", and the difference matters because
//! the wrong answer silently changes where every task goes.
//!
//! NO TOKEN LIVES HERE. The config names the environment variable that carries
//! one, never the value, for the same reason a credential profile names a
//! directory rather than holding credentials: this file is read by several
//! surfaces and reported by a route, and a secret in it would travel with
//! every one of them.
//!
//! Parsing is separate from the file I/O, the way `fleet_usage.rs` splits
//! them, so these rules are provable without a disk.

use serde_json::{Value, json};

/// The Linear configuration, or why it could not be read.
///
/// Three outcomes rather than two. `Absent` is the ordinary state of an
/// account that has not chosen Linear and MUST keep using the local task
/// engine; `Unreadable` is a configuration somebody wrote that we cannot
/// understand. Collapsing them would silently fall back to the local engine
/// while the config says Linear, which splits a person's tasks across two
/// systems with nothing saying so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinearSettings {
    /// Nobody has configured Linear. The local task engine stays in charge.
    Absent,
    /// Configured, and these are the parts that matter.
    Configured {
        /// Which Linear project tasks belong to. Required: without it a task
        /// would land wherever Linear defaults, which is somebody else's
        /// backlog.
        project: String,
        /// The NAME of the environment variable holding the API token, never
        /// the token. Absent means the token has not been named yet, which is
        /// a configuration that cannot be used and says so.
        token_env: Option<String>,
    },
    /// Could not be understood, with the reason.
    Unreadable(String),
}

impl LinearSettings {
    /// Whether Linear should handle tasks instead of the local engine.
    ///
    /// False for `Unreadable`, and the caller is expected to surface the
    /// reason rather than proceed: this is the question that decides where a
    /// task goes, so "we could not tell" must not read as "use the local one".
    pub fn replaces_local_tasks(&self) -> bool {
        matches!(self, Self::Configured { .. })
    }
}

/// Read the Linear block out of an already-loaded config.
pub fn parse_linear_settings(config: &Value) -> LinearSettings {
    let Some(block) = config.get("linear") else {
        return LinearSettings::Absent;
    };
    let Some(block) = block.as_object() else {
        return LinearSettings::Unreadable(
            "linear is not an object in the Aimux config".to_owned(),
        );
    };
    // An EMPTY block is absent rather than broken: it is what a hand edit
    // leaves behind after removing the settings, and refusing it would stop
    // the local engine working on a machine nobody has configured.
    if block.is_empty() {
        return LinearSettings::Absent;
    }
    let project = block
        .get("project")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|project| !project.is_empty());
    let Some(project) = project else {
        return LinearSettings::Unreadable(
            "linear.project is missing, so there is nowhere for a task to go".to_owned(),
        );
    };
    let token_env = block
        .get("tokenEnv")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned);
    // A token VALUE in the config is refused rather than used. This file is
    // reported by a route and read by several surfaces, so a secret in it
    // would travel with all of them -- and somebody who put one here needs
    // telling, not accommodating.
    if block.contains_key("token") || block.contains_key("apiKey") {
        return LinearSettings::Unreadable(
            "linear carries a token in the Aimux config; name the environment variable in linear.tokenEnv instead, because this file is reported by routes".to_owned(),
        );
    }
    LinearSettings::Configured {
        project: project.to_owned(),
        token_env,
    }
}

/// What the settings are, for a route to report.
pub fn linear_settings_report(settings: &LinearSettings) -> Value {
    match settings {
        LinearSettings::Absent => json!({
            "ok": true,
            "configured": false,
            // Said in the report rather than inferred by the reader: the
            // local engine being in charge is the useful half of this answer.
            "tasks": "aimux",
        }),
        LinearSettings::Configured { project, token_env } => json!({
            "ok": true,
            "configured": true,
            "tasks": "linear",
            "project": project,
            // The NAME, which is not a secret. Null when nobody has named it,
            // which is a configuration that cannot be used yet.
            "tokenEnv": token_env,
        }),
        // No `configured` key at all, for the reason `unknown_machines_report`
        // omits `machines`: `false` would read as an account that has not
        // chosen Linear, which is the opposite of what this means.
        LinearSettings::Unreadable(reason) => json!({ "ok": false, "error": reason }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_linear_block_leaves_the_local_task_engine_in_charge() {
        let settings = parse_linear_settings(&json!({ "somethingElse": true }));
        assert_eq!(settings, LinearSettings::Absent);
        assert!(!settings.replaces_local_tasks());
        assert_eq!(linear_settings_report(&settings)["tasks"], json!("aimux"));
    }

    /// What a hand edit leaves behind after removing the settings. Refusing it
    /// would stop the local engine working on a machine nobody configured.
    #[test]
    fn an_empty_linear_block_is_absent_rather_than_broken() {
        assert_eq!(
            parse_linear_settings(&json!({ "linear": {} })),
            LinearSettings::Absent
        );
    }

    #[test]
    fn a_named_project_configures_linear_and_replaces_local_tasks() {
        let settings = parse_linear_settings(&json!({
            "linear": { "project": "Aimux", "tokenEnv": "AIMUX_LINEAR_TOKEN" },
        }));
        assert_eq!(
            settings,
            LinearSettings::Configured {
                project: "Aimux".to_owned(),
                token_env: Some("AIMUX_LINEAR_TOKEN".to_owned()),
            }
        );
        assert!(settings.replaces_local_tasks());
        let report = linear_settings_report(&settings);
        assert_eq!(report["tasks"], json!("linear"));
        assert_eq!(report["project"], json!("Aimux"));
    }

    /// Required, because without it a task lands wherever Linear defaults,
    /// which is somebody else's backlog.
    #[test]
    fn a_linear_block_with_no_project_is_unreadable() {
        match parse_linear_settings(&json!({ "linear": { "tokenEnv": "T" } })) {
            LinearSettings::Unreadable(reason) => {
                assert!(reason.contains("nowhere for a task to go"), "{reason}");
            }
            other => panic!("a projectless block parsed as {other:?}"),
        }
    }

    /// The distinction the enum exists for. An unreadable config must not read
    /// as an account that chose the local engine: that splits a person's tasks
    /// across two systems with nothing saying so.
    #[test]
    fn an_unreadable_block_does_not_read_as_an_unconfigured_account() {
        let settings = parse_linear_settings(&json!({ "linear": "Aimux" }));
        match &settings {
            LinearSettings::Unreadable(reason) => {
                assert!(reason.contains("not an object"), "{reason}");
            }
            other => panic!("a string block parsed as {other:?}"),
        }
        assert!(!settings.replaces_local_tasks());
        let report = linear_settings_report(&settings);
        assert_eq!(report["ok"], json!(false));
        assert!(
            report.get("configured").is_none(),
            "an unreadable config reported a configured flag: {report}"
        );
    }

    /// A secret in a file a route reports would travel with every surface that
    /// reads it, so somebody who put one there gets told rather than
    /// accommodated.
    #[test]
    fn a_token_value_in_the_config_is_refused() {
        for key in ["token", "apiKey"] {
            let config = json!({ "linear": { "project": "Aimux", key: "lin_api_secret" } });
            match parse_linear_settings(&config) {
                LinearSettings::Unreadable(reason) => {
                    assert!(reason.contains("tokenEnv"), "{reason}");
                    assert!(
                        !reason.contains("lin_api_secret"),
                        "the refusal echoed the secret back: {reason}"
                    );
                }
                other => panic!("a config carrying {key} parsed as {other:?}"),
            }
        }
    }

    /// Configured but with no token named is a configuration that cannot be
    /// used, and it has to be distinguishable from one that can.
    #[test]
    fn a_project_without_a_named_token_is_configured_but_says_so() {
        let settings = parse_linear_settings(&json!({ "linear": { "project": "Aimux" } }));
        assert_eq!(
            settings,
            LinearSettings::Configured {
                project: "Aimux".to_owned(),
                token_env: None,
            }
        );
        assert_eq!(
            linear_settings_report(&settings)["tokenEnv"],
            Value::Null,
            "a configuration with no token must not look like one with a token"
        );
    }
}
