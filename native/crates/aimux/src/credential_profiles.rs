//! Named credential profiles: which tool account a launch should use.
//!
//! A profile is a NAME for a pair of directories, nothing more. Switching
//! accounts means pointing new agents at a different `CLAUDE_CONFIG_DIR` or
//! `CODEX_HOME`, which `managed_launch_env` already allows and
//! `agent_session_launch` already honours through `launch_env`. So there are no
//! credentials here and no keychain: a profile is a label somebody chose for a
//! directory they already have.
//!
//! The parsing is kept separate from the file I/O for the reason
//! `fleet_usage.rs` gives: the invariants below are the part worth proving, and
//! they are provable without touching a disk.

use serde_json::{Value, json};
use std::collections::BTreeMap;

/// The directories one profile names.
///
/// Both are optional and independent: a profile may switch only the Claude
/// account and leave Codex on whatever the machine already uses. A profile
/// that names NEITHER is not a profile, and `parse_credential_profiles`
/// refuses it rather than storing a label that changes nothing.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CredentialProfile {
    pub claude_config_dir: Option<String>,
    pub codex_home: Option<String>,
}

impl CredentialProfile {
    /// The env a launch should carry for this profile.
    ///
    /// Only the directories the profile actually names. An absent directory is
    /// LEFT ALONE rather than cleared: a Claude-only profile must not silently
    /// move the Codex account, and setting an empty value would not clear it
    /// anyway -- `build_managed_launch_env` drops empty values, so the agent
    /// would fall back to the tool default instead of to the machine's.
    pub fn launch_env(&self) -> Vec<(String, String)> {
        let mut env = Vec::new();
        if let Some(dir) = &self.claude_config_dir {
            env.push(("CLAUDE_CONFIG_DIR".to_owned(), dir.clone()));
        }
        if let Some(home) = &self.codex_home {
            env.push(("CODEX_HOME".to_owned(), home.clone()));
        }
        env
    }
}

/// What the stored profile set says, or why it could not be read.
///
/// Three outcomes, not two. A config file that could not be PARSED is not a
/// machine with no profiles: the first would lose a switch somebody made and
/// the second is the ordinary state of a machine nobody has configured, and a
/// caller that cannot tell them apart will report "no profiles" for a corrupt
/// file and quietly launch against the wrong account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialProfiles {
    /// Parsed. May legitimately be empty.
    Known {
        profiles: BTreeMap<String, CredentialProfile>,
        /// The profile new launches should use, if one is chosen AND exists.
        active: Option<String>,
    },
    /// Could not be understood, with the reason.
    Unreadable(String),
}

/// Read the profile block out of an already-loaded config value.
///
/// Takes the config rather than a path so the rules below are provable without
/// a filesystem. An ABSENT block is `Known` with nothing in it -- a machine
/// nobody configured is not an error -- while a block of the wrong SHAPE is
/// `Unreadable`, because somebody meant something by it and we cannot tell
/// what.
pub fn parse_credential_profiles(config: &Value) -> CredentialProfiles {
    let Some(block) = config.get("credentialProfiles") else {
        return CredentialProfiles::Known {
            profiles: BTreeMap::new(),
            active: None,
        };
    };
    let Some(block) = block.as_object() else {
        return CredentialProfiles::Unreadable(
            "credentialProfiles is not an object in the Aimux config".to_owned(),
        );
    };
    let mut profiles = BTreeMap::new();
    if let Some(named) = block.get("profiles") {
        let Some(named) = named.as_object() else {
            return CredentialProfiles::Unreadable(
                "credentialProfiles.profiles is not an object in the Aimux config".to_owned(),
            );
        };
        for (name, entry) in named {
            let Some(entry) = entry.as_object() else {
                return CredentialProfiles::Unreadable(format!(
                    "credential profile {name} is not an object"
                ));
            };
            let directory = |key: &str| {
                entry
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    // An empty or whitespace path names nothing. Kept out here
                    // rather than at launch, so a profile cannot promise a
                    // switch it will not make.
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
            };
            let profile = CredentialProfile {
                claude_config_dir: directory("claudeConfigDir"),
                codex_home: directory("codexHome"),
            };
            if profile == CredentialProfile::default() {
                return CredentialProfiles::Unreadable(format!(
                    "credential profile {name} names no directory, so switching to it would change nothing"
                ));
            }
            profiles.insert(name.clone(), profile);
        }
    }
    let active = block
        .get("active")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned);
    // An active name that matches no profile is REFUSED rather than ignored.
    // Ignoring it would launch against the machine's default while the config
    // says otherwise, which is the shape of mistake nobody notices until a
    // month of work has gone through the wrong account.
    if let Some(name) = &active
        && !profiles.contains_key(name)
    {
        return CredentialProfiles::Unreadable(format!(
            "credential profile {name} is active but not defined"
        ));
    }
    CredentialProfiles::Known { profiles, active }
}

/// The env new launches on this machine should carry.
///
/// Empty when no profile is active, which is the ordinary case and means "use
/// whatever the machine already uses". An unreadable config yields NO env and
/// the caller is expected to surface the reason -- see
/// `CredentialProfiles::Unreadable`, which exists so that choice is explicit
/// rather than a silent fallback to the default account.
pub fn active_launch_env(profiles: &CredentialProfiles) -> Vec<(String, String)> {
    match profiles {
        CredentialProfiles::Known { profiles, active } => active
            .as_ref()
            .and_then(|name| profiles.get(name))
            .map(CredentialProfile::launch_env)
            .unwrap_or_default(),
        CredentialProfiles::Unreadable(_) => Vec::new(),
    }
}

/// Profiles from a config READ, which may itself have failed.
///
/// The same hole as `linear_settings_from_config_read`, and here it defeated
/// the spawn refusal: `load_global_config_with_resolver` swallowing a read
/// error produced `Known` with no active profile, so an agent LAUNCHED against
/// whatever account the machine defaults to. An active profile is an explicit
/// instruction about credentials, and running work somewhere nobody asked for
/// is worse than refusing to start.
pub fn credential_profiles_from_config_read(read: Result<Value, String>) -> CredentialProfiles {
    match read {
        Ok(config) => parse_credential_profiles(&config),
        Err(reason) => {
            CredentialProfiles::Unreadable(format!("the Aimux config could not be read: {reason}"))
        }
    }
}

/// Render the profile set for a route, keeping the three outcomes apart.
pub fn credential_profiles_report(profiles: &CredentialProfiles) -> Value {
    match profiles {
        CredentialProfiles::Known { profiles, active } => json!({
            "ok": true,
            "active": active,
            "profiles": profiles
                .iter()
                .map(|(name, profile)| json!({
                    "name": name,
                    "claudeConfigDir": profile.claude_config_dir,
                    "codexHome": profile.codex_home,
                }))
                .collect::<Vec<Value>>(),
        }),
        // No `profiles` key at all, for the reason `unknown_machines_report`
        // omits `machines`: an empty list would read as a machine with none.
        CredentialProfiles::Unreadable(reason) => json!({ "ok": false, "error": reason }),
    }
}

/// Choose which profile new launches use, or clear the choice.
///
/// `None` clears it, which means "go back to whatever accounts this machine
/// already had" -- a real and distinct instruction from switching, so it has
/// to be expressible rather than approximated by setting some default name.
///
/// REFUSES A NAME THAT IS NOT DEFINED. Storing one would write a config that
/// `parse_credential_profiles` then calls unreadable, which by design refuses
/// every spawn -- so a typo at the switch would stop the machine launching
/// agents at all, and the error would point at the config rather than at the
/// command that broke it. Caught here, where the person is still looking.
///
/// Takes and returns the config VALUE rather than touching a file, so the
/// read-modify-write below is the only thing that needs a disk and these rules
/// stay provable without one. Everything outside `credentialProfiles` is
/// preserved: this edits one block of a file other features also own.
pub fn with_active_profile(config: &Value, name: Option<&str>) -> Result<Value, String> {
    let parsed = parse_credential_profiles(config);
    let profiles = match &parsed {
        CredentialProfiles::Known { profiles, .. } => profiles,
        // Refused rather than overwritten. A config we cannot parse may hold
        // profiles somebody wrote by hand, and replacing the block to make the
        // switch work would throw them away to carry out a command that said
        // nothing about them.
        CredentialProfiles::Unreadable(reason) => {
            return Err(format!(
                "the credential profiles on this machine could not be read, so the active profile was not changed: {reason}"
            ));
        }
    };
    if let Some(name) = name
        && !profiles.contains_key(name)
    {
        let mut known: Vec<&str> = profiles.keys().map(String::as_str).collect();
        known.sort_unstable();
        return Err(if known.is_empty() {
            format!("no credential profile named {name}, and this machine has none defined")
        } else {
            format!(
                "no credential profile named {name}; this machine has {}",
                known.join(", ")
            )
        });
    }
    let mut next = config.clone();
    let root = next
        .as_object_mut()
        .ok_or_else(|| "the Aimux config is not an object".to_owned())?;
    let block = root
        .entry("credentialProfiles")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "credentialProfiles is not an object in the Aimux config".to_owned())?;
    match name {
        Some(name) => {
            block.insert("active".to_owned(), Value::String(name.to_owned()));
        }
        // Removed rather than set to null, so a cleared choice leaves a config
        // that reads the same as one where nobody ever chose.
        None => {
            block.remove("active");
        }
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switching_to_a_defined_profile_records_it() {
        let config = json!({
            "credentialProfiles": {
                "profiles": { "work": { "claudeConfigDir": "/profiles/work/.claude" } },
            },
        });
        let next = with_active_profile(&config, Some("work")).expect("work is defined");
        assert_eq!(next["credentialProfiles"]["active"], json!("work"));
        assert_eq!(
            active_launch_env(&parse_credential_profiles(&next)),
            vec![(
                "CLAUDE_CONFIG_DIR".to_owned(),
                "/profiles/work/.claude".to_owned()
            )]
        );
    }

    /// A typo must not be storable. Writing an undefined name produces a
    /// config `parse_credential_profiles` calls unreadable, which refuses
    /// every spawn -- so the machine would stop launching agents and the error
    /// would point at the config rather than at the command that broke it.
    #[test]
    fn switching_to_an_undefined_profile_is_refused_and_names_what_exists() {
        let config = json!({
            "credentialProfiles": {
                "profiles": { "work": { "claudeConfigDir": "/profiles/work/.claude" } },
            },
        });
        let error = with_active_profile(&config, Some("wrok")).expect_err("wrok is not defined");
        assert!(
            error.contains("no credential profile named wrok"),
            "{error}"
        );
        assert!(
            error.contains("work"),
            "the refusal did not say what does exist: {error}"
        );
    }

    #[test]
    fn switching_on_a_machine_with_no_profiles_says_so() {
        let error = with_active_profile(&json!({}), Some("work")).expect_err("none are defined");
        assert!(error.contains("has none defined"), "{error}");
    }

    /// Clearing is its own instruction, and leaves a config that reads the
    /// same as one where nobody ever chose.
    #[test]
    fn clearing_the_active_profile_removes_the_key_rather_than_nulling_it() {
        let config = json!({
            "credentialProfiles": {
                "active": "work",
                "profiles": { "work": { "claudeConfigDir": "/profiles/work/.claude" } },
            },
        });
        let next = with_active_profile(&config, None).expect("clearing always works");
        assert!(
            next["credentialProfiles"].get("active").is_none(),
            "active was nulled rather than removed: {next}"
        );
        assert!(active_launch_env(&parse_credential_profiles(&next)).is_empty());
    }

    /// This edits one block of a file other features own.
    #[test]
    fn switching_preserves_the_rest_of_the_config() {
        let config = json!({
            "somethingElse": { "keep": true },
            "credentialProfiles": {
                "profiles": { "work": { "codexHome": "/profiles/work/.codex" } },
            },
        });
        let next = with_active_profile(&config, Some("work")).expect("work is defined");
        assert_eq!(next["somethingElse"], json!({ "keep": true }));
        assert_eq!(
            next["credentialProfiles"]["profiles"]["work"]["codexHome"],
            json!("/profiles/work/.codex")
        );
    }

    /// An unreadable block may hold hand-written profiles. Replacing it to
    /// make the switch work would throw them away to carry out a command that
    /// said nothing about them.
    #[test]
    fn switching_on_an_unreadable_config_refuses_rather_than_overwriting() {
        let config = json!({ "credentialProfiles": "work" });
        let error = with_active_profile(&config, Some("work"))
            .expect_err("an unreadable block must not be overwritten");
        assert!(error.contains("could not be read"), "{error}");
        assert!(
            error.contains("was not changed"),
            "the refusal did not say the switch did not happen: {error}"
        );
    }

    #[test]
    fn a_machine_with_no_profile_block_has_no_profiles_and_is_not_an_error() {
        let parsed = parse_credential_profiles(&json!({ "somethingElse": true }));
        assert_eq!(
            parsed,
            CredentialProfiles::Known {
                profiles: BTreeMap::new(),
                active: None,
            }
        );
        assert!(active_launch_env(&parsed).is_empty());
    }

    /// The distinction the enum exists for. A config that could not be parsed
    /// must not read as a machine with no profiles: the first loses a switch
    /// somebody made, and a caller that confuses them launches against the
    /// wrong account while reporting everything is fine.
    #[test]
    fn a_malformed_profile_block_is_unreadable_and_not_an_empty_set() {
        let parsed = parse_credential_profiles(&json!({ "credentialProfiles": "work" }));
        match &parsed {
            CredentialProfiles::Unreadable(reason) => {
                assert!(reason.contains("not an object"), "{reason}");
            }
            other => panic!("a string profile block parsed as {other:?}"),
        }
        let report = credential_profiles_report(&parsed);
        assert_eq!(report["ok"], json!(false));
        assert!(
            report.get("profiles").is_none(),
            "an unreadable config reported a profile list: {report}"
        );
    }

    #[test]
    fn a_profile_names_only_the_directories_it_sets() {
        let parsed = parse_credential_profiles(&json!({
            "credentialProfiles": {
                "active": "work",
                "profiles": {
                    "work": { "claudeConfigDir": "/profiles/work/.claude" },
                },
            },
        }));
        assert_eq!(
            active_launch_env(&parsed),
            vec![(
                "CLAUDE_CONFIG_DIR".to_owned(),
                "/profiles/work/.claude".to_owned()
            )],
            "a Claude-only profile must not also set CODEX_HOME"
        );
    }

    #[test]
    fn both_directories_travel_when_a_profile_names_both() {
        let parsed = parse_credential_profiles(&json!({
            "credentialProfiles": {
                "active": "personal",
                "profiles": {
                    "personal": {
                        "claudeConfigDir": "/profiles/personal/.claude",
                        "codexHome": "/profiles/personal/.codex",
                    },
                },
            },
        }));
        let env = active_launch_env(&parsed);
        assert_eq!(env.len(), 2);
        assert!(env.contains(&(
            "CODEX_HOME".to_owned(),
            "/profiles/personal/.codex".to_owned()
        )));
    }

    /// Defined but not active means the machine keeps its own accounts. A
    /// profile existing is not a profile being used.
    #[test]
    fn a_defined_but_inactive_profile_changes_no_launch() {
        let parsed = parse_credential_profiles(&json!({
            "credentialProfiles": {
                "profiles": {
                    "work": { "claudeConfigDir": "/profiles/work/.claude" },
                },
            },
        }));
        assert!(active_launch_env(&parsed).is_empty());
    }

    /// The mistake nobody notices for a month. An active name matching no
    /// profile has to be refused: ignoring it launches against the machine's
    /// default while the config says otherwise.
    #[test]
    fn an_active_profile_that_does_not_exist_is_refused_not_ignored() {
        let parsed = parse_credential_profiles(&json!({
            "credentialProfiles": {
                "active": "work",
                "profiles": {
                    "personal": { "codexHome": "/profiles/personal/.codex" },
                },
            },
        }));
        match parsed {
            CredentialProfiles::Unreadable(reason) => {
                assert!(reason.contains("active but not defined"), "{reason}");
            }
            other => panic!("a dangling active profile parsed as {other:?}"),
        }
    }

    /// An empty path names nothing, and `build_managed_launch_env` would drop
    /// it anyway -- so a profile built from one promises a switch it cannot
    /// make. Refused at parse time rather than discovered at launch.
    #[test]
    fn a_profile_whose_directories_are_blank_is_refused() {
        let parsed = parse_credential_profiles(&json!({
            "credentialProfiles": {
                "profiles": { "work": { "claudeConfigDir": "   ", "codexHome": "" } },
            },
        }));
        match parsed {
            CredentialProfiles::Unreadable(reason) => {
                assert!(reason.contains("names no directory"), "{reason}");
            }
            other => panic!("a blank profile parsed as {other:?}"),
        }
    }
}
