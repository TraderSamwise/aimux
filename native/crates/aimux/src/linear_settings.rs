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

/// Whether the token Linear needs can actually be read.
///
/// Separate from `LinearSettings` because the two fail differently and a
/// person fixes them in different places: the settings are a config edit, and
/// a missing token is an environment the daemon was started without. Telling
/// somebody "Linear is not configured" when the project is named and only the
/// variable is unset sends them to the wrong file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinearToken {
    /// Readable, and this is its length -- never the value.
    ///
    /// The length is carried so a report can say the variable holds SOMETHING
    /// without printing it. A bare "set" cannot distinguish a real token from
    /// an accidental empty-ish value, and printing the token would put it in
    /// every surface that renders this.
    Readable { env: String, length: usize },
    /// The config names a variable and the environment does not have it.
    Missing { env: String },
    /// The config names a variable and it is set to nothing, which is a
    /// different mistake from not setting it -- usually an export that lost
    /// its value -- and worth saying separately.
    Empty { env: String },
    /// No variable is named, so there is nothing to look up yet.
    Unnamed,
}

/// Resolve the token from an environment, without touching the process one.
///
/// Takes a lookup so the rules below are provable: a test supplies its own
/// environment rather than mutating the process's, which would make these
/// tests order-dependent against every other test in the binary.
pub fn resolve_linear_token(
    settings: &LinearSettings,
    lookup: impl Fn(&str) -> Option<String>,
) -> LinearToken {
    let LinearSettings::Configured { token_env, .. } = settings else {
        return LinearToken::Unnamed;
    };
    let Some(env) = token_env else {
        return LinearToken::Unnamed;
    };
    match lookup(env) {
        Some(value) if value.trim().is_empty() => LinearToken::Empty { env: env.clone() },

        Some(value) => LinearToken::Readable {
            env: env.clone(),
            // Counted on the TRIMMED value, because surrounding whitespace in
            // an exported variable is not token material and a length that
            // included it would overstate what is there.
            length: value.trim().chars().count(),
        },
        None => LinearToken::Missing { env: env.clone() },
    }
}

/// Whether Linear can actually be reached, as opposed to merely chosen.
pub fn linear_is_usable(settings: &LinearSettings, token: &LinearToken) -> bool {
    settings.replaces_local_tasks() && matches!(token, LinearToken::Readable { .. })
}

/// One line about the token, for a route to render.
///
/// Never the value, and never a prefix of it: a prefix is still key material
/// and this string is rendered by the CLI and reported as JSON.
pub fn linear_token_line(token: &LinearToken) -> String {
    match token {
        LinearToken::Readable { env, length } => {
            format!("Token read from {env} ({length} characters).")
        }
        LinearToken::Missing { env } => {
            format!("{env} is not set in the daemon's environment, so Linear cannot be reached.")
        }
        LinearToken::Empty { env } => {
            format!("{env} is set but empty, so Linear cannot be reached.")
        }
        LinearToken::Unnamed => {
            "No token environment variable is named, so Linear cannot be reached yet.".to_owned()
        }
    }
}

/// Settings from a config READ, which may itself have failed.
///
/// This exists because `load_global_config_with_resolver` swallows a read
/// error and hands back the defaults, which is indistinguishable from a config
/// with no `linear` block. That made `Unreadable` UNREACHABLE through the
/// loader every route used: a config file that could not be read reported
/// "tasks stay in Aimux" while the file may well have named a Linear project.
/// Silently sending work to the wrong system is the exact failure the three
/// outcomes exist to prevent, so the distinction has to survive the read.
///
/// Takes the `Result` rather than a resolver so it is pure and the mapping is
/// provable without a filesystem.
pub fn linear_settings_from_config_read(read: Result<Value, String>) -> LinearSettings {
    match read {
        Ok(config) => parse_linear_settings(&config),
        Err(reason) => {
            LinearSettings::Unreadable(format!("the Aimux config could not be read: {reason}"))
        }
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

    fn configured(env: Option<&str>) -> LinearSettings {
        LinearSettings::Configured {
            project: "Aimux".to_owned(),
            token_env: env.map(str::to_owned),
        }
    }

    #[test]
    fn a_named_and_set_variable_is_readable_and_never_echoed() {
        let token = resolve_linear_token(&configured(Some("AIMUX_LINEAR_TOKEN")), |name| {
            (name == "AIMUX_LINEAR_TOKEN").then(|| "lin_api_secret_value".to_owned())
        });
        assert_eq!(
            token,
            LinearToken::Readable {
                env: "AIMUX_LINEAR_TOKEN".to_owned(),
                length: "lin_api_secret_value".chars().count(),
            }
        );
        let line = linear_token_line(&token);
        assert!(line.contains("AIMUX_LINEAR_TOKEN"), "{line}");
        assert!(
            !line.contains("lin_api_secret_value"),
            "the token line echoed the value: {line}"
        );
        assert!(
            !line.contains("lin_api"),
            "the token line echoed a prefix, which is still key material: {line}"
        );
    }

    /// The three failures a person fixes differently. Collapsing them sends
    /// somebody to the wrong file: unset is an environment problem, empty is
    /// usually an export that lost its value, and unnamed is a config edit.
    #[test]
    fn unset_empty_and_unnamed_are_three_different_answers() {
        let unset = resolve_linear_token(&configured(Some("T")), |_| None);
        assert_eq!(
            unset,
            LinearToken::Missing {
                env: "T".to_owned()
            }
        );
        assert!(linear_token_line(&unset).contains("is not set"));

        let empty = resolve_linear_token(&configured(Some("T")), |_| Some("   ".to_owned()));
        assert_eq!(
            empty,
            LinearToken::Empty {
                env: "T".to_owned()
            }
        );
        assert!(linear_token_line(&empty).contains("set but empty"));

        let unnamed = resolve_linear_token(&configured(None), |_| Some("x".to_owned()));
        assert_eq!(unnamed, LinearToken::Unnamed);
        assert!(linear_token_line(&unnamed).contains("No token environment variable"));
    }

    /// Whitespace around an exported value is not token material, so the
    /// length must not count it -- a length that did would overstate what is
    /// there and make an almost-empty variable look fine.
    #[test]
    fn the_reported_length_ignores_surrounding_whitespace() {
        let token = resolve_linear_token(&configured(Some("T")), |_| Some("  abc  ".to_owned()));
        assert_eq!(
            token,
            LinearToken::Readable {
                env: "T".to_owned(),
                length: 3,
            }
        );
    }

    #[test]
    fn an_unconfigured_account_has_nothing_to_look_up() {
        assert_eq!(
            resolve_linear_token(&LinearSettings::Absent, |_| Some("x".to_owned())),
            LinearToken::Unnamed
        );
        assert_eq!(
            resolve_linear_token(&LinearSettings::Unreadable("broken".to_owned()), |_| Some(
                "x".to_owned()
            )),
            LinearToken::Unnamed
        );
    }

    /// CHOSEN is not REACHABLE, and the difference is the whole point of this
    /// pair: a project named with no token set would otherwise look ready.
    #[test]
    fn linear_is_usable_only_when_chosen_and_readable() {
        let settings = configured(Some("T"));
        assert!(linear_is_usable(
            &settings,
            &LinearToken::Readable {
                env: "T".to_owned(),
                length: 10
            }
        ));
        assert!(!linear_is_usable(
            &settings,
            &LinearToken::Missing {
                env: "T".to_owned()
            }
        ));
        assert!(!linear_is_usable(
            &settings,
            &LinearToken::Empty {
                env: "T".to_owned()
            }
        ));
        // And an unconfigured account is not usable however the environment
        // looks, because nothing chose Linear.
        assert!(!linear_is_usable(
            &LinearSettings::Absent,
            &LinearToken::Readable {
                env: "T".to_owned(),
                length: 10
            }
        ));
    }

    /// THE HOLE THIS CLOSES. `load_global_config_with_resolver` turns a read
    /// failure into the defaults, so a config that could not be READ used to
    /// report `Absent` -- "tasks stay in Aimux" -- while the file may have
    /// named a Linear project. That silently sends work to the wrong system,
    /// which is what the three outcomes exist to prevent.
    #[test]
    fn a_config_that_could_not_be_read_is_unreadable_not_absent() {
        let settings = linear_settings_from_config_read(Err("permission denied".to_owned()));
        assert_ne!(
            settings,
            LinearSettings::Absent,
            "an unreadable config reported a standalone account"
        );
        let LinearSettings::Unreadable(reason) = &settings else {
            panic!("expected Unreadable, got {settings:?}");
        };
        // The underlying reason survives, so a person is told what to fix.
        assert!(reason.contains("permission denied"), "{reason}");
        assert!(!settings.replaces_local_tasks(), "{settings:?}");
    }

    /// A config that READ fine still parses normally, both ways -- the fix
    /// must not turn every account into an error.
    #[test]
    fn a_readable_config_still_parses_as_it_did() {
        assert_eq!(
            linear_settings_from_config_read(Ok(json!({}))),
            LinearSettings::Absent
        );
        assert_eq!(
            linear_settings_from_config_read(Ok(json!({
                "linear": { "project": "Aimux", "tokenEnv": "T" }
            }))),
            LinearSettings::Configured {
                project: "Aimux".to_owned(),
                token_env: Some("T".to_owned()),
            }
        );
    }

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
