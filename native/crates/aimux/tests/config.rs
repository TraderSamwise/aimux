use aimux::config::{
    deep_merge, default_config, init_project_with_resolver, load_global_config_with_resolver,
    merge_config_layers,
};
use aimux::paths::PathResolver;
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_path(label: &str) -> PathBuf {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_millis();
    std::env::temp_dir().join(format!(
        "aimux-config-{label}-{millis}-{}",
        std::process::id()
    ))
}

#[test]
fn defaults_match_the_type_script_contract_fixture() {
    let expected: Value = serde_json::from_str(include_str!(
        "../../../../testdata/contracts/v1/config/default.json"
    ))
    .expect("valid config default fixture");

    assert_eq!(default_config(), expected);
}

#[test]
fn init_project_creates_local_and_global_state_without_overwriting_config() {
    let temp = temp_path("init");
    let repo = temp.join("repo");
    let home = temp.join("home");
    fs::create_dir_all(repo.join(".git")).expect("repo git");
    fs::create_dir_all(&home).expect("home");
    let mut resolver = PathResolver::new(&repo, &home, None);
    init_project_with_resolver(&mut resolver, &repo).expect("init project");

    for subdir in ["plans", "context", "history", "status"] {
        assert!(repo.join(".aimux").join(subdir).is_dir(), "{subdir}");
    }
    assert!(repo.join(".aimux/config.json").is_file());
    assert_eq!(
        fs::read_to_string(repo.join(".aimux/.gitignore")).expect("gitignore"),
        "# Runtime-private service/project state (lives in ~/.aimux/projects/)\nstate.json\n\n# Agent-facing shared artifacts\ncontext/\nhistory/\ntasks/\nstatus/\nthreads/\n\n# Terminal recordings (large, machine-specific)\nrecordings/\n\n# Agent plan files\nplans/\n\n# Managed git worktrees\nworktrees/\n\n"
    );
    assert!(
        !resolver
            .project_state_dir_for(&repo)
            .join("recordings")
            .exists()
    );

    fs::write(
        repo.join(".aimux/config.json"),
        "{\"defaultTool\":\"codex\"}\n",
    )
    .expect("custom config");
    init_project_with_resolver(&mut resolver, &repo).expect("second init");
    assert_eq!(
        fs::read_to_string(repo.join(".aimux/config.json")).expect("config"),
        "{\"defaultTool\":\"codex\"}\n"
    );

    fs::remove_dir_all(temp).expect("cleanup");
}

#[test]
fn init_project_allows_non_git_directories_like_typescript() {
    let temp = temp_path("non-git-init");
    let repo = temp.join("repo");
    let home = temp.join("home");
    fs::create_dir_all(&repo).expect("repo");
    fs::create_dir_all(&home).expect("home");
    let mut resolver = PathResolver::new(&repo, &home, None);

    init_project_with_resolver(&mut resolver, &repo).expect("non-git init");

    for subdir in ["plans", "context", "history", "status"] {
        assert!(repo.join(".aimux").join(subdir).is_dir(), "{subdir}");
    }
    assert!(repo.join(".aimux/config.json").is_file());
    assert!(repo.join(".aimux/.gitignore").is_file());
    fs::remove_dir_all(temp).expect("cleanup");
}

#[test]
fn load_global_config_reads_only_global_layer() {
    let temp = temp_path("global");
    let repo = temp.join("repo");
    let home = temp.join("home");
    fs::create_dir_all(repo.join(".aimux")).expect("repo aimux");
    fs::create_dir_all(home.join(".aimux")).expect("home aimux");
    let mut resolver = PathResolver::new(
        &repo,
        &home,
        Some(home.join(".aimux").to_string_lossy().into_owned()),
    );
    fs::write(
        resolver.global_config_path(),
        "{\"defaultTool\":\"codex\",\"expose\":{\"hotSnapshotsEnabled\":false}}\n",
    )
    .expect("global config");
    fs::write(
        resolver.config_path_for(&repo),
        "{\"defaultTool\":\"claude\",\"expose\":{\"hotSnapshotsEnabled\":true}}\n",
    )
    .expect("project config");

    let config = load_global_config_with_resolver(&resolver);

    assert_eq!(config["defaultTool"], "codex");
    assert_eq!(config["expose"]["hotSnapshotsEnabled"], false);
    fs::remove_dir_all(temp).expect("cleanup");
}

#[test]
fn deep_merge_recurses_through_objects_and_replaces_arrays_and_scalars() {
    let base = json!({
        "nested": { "kept": true, "changed": 1 },
        "array": ["base"],
        "nullable": { "value": true }
    });
    let overrides = json!({
        "nested": { "changed": 2, "added": true },
        "array": ["override"],
        "nullable": null
    });

    assert_eq!(
        deep_merge(&base, &overrides),
        json!({
            "nested": { "kept": true, "changed": 2, "added": true },
            "array": ["override"],
            "nullable": null
        })
    );
}

#[test]
fn deep_merge_mirrors_javascript_object_keys_for_top_level_layers() {
    assert_eq!(
        deep_merge(&json!({ "a": 1 }), &json!(["zero", "one"])),
        json!({ "a": 1, "0": "zero", "1": "one" })
    );
    assert_eq!(
        deep_merge(&json!({ "a": 1 }), &json!("xy")),
        json!({ "a": 1, "0": "x", "1": "y" })
    );
    assert_eq!(
        deep_merge(&json!({ "a": 1 }), &json!(true)),
        json!({ "a": 1 })
    );
}

#[test]
#[should_panic(expected = "Cannot convert undefined or null to object")]
fn deep_merge_panics_on_null_like_javascript_object_keys() {
    let _ = deep_merge(&json!({ "a": 1 }), &Value::Null);
}

#[test]
fn layers_defaults_global_and_project_while_protecting_global_only_config() {
    let global = json!({
        "graveyard": { "cleanupEnabled": false, "retentionDays": 30 },
        "loop": { "overseerBriefingTemplate": "global" },
        "hosted": { "enabled": true },
        "installs": { "root": "/global" }
    });
    let project = json!({
        "graveyard": { "retentionDays": 7 },
        "loop": { "overseerBriefingTemplate": "project" },
        "hosted": { "enabled": false },
        "installs": { "root": "/project" }
    });

    let config = merge_config_layers(Some(&global), Some(&project));
    assert_eq!(
        config["graveyard"],
        json!({
            "cleanupEnabled": false,
            "retentionDays": 7,
            "cleanupIntervalMs": 86_400_000
        })
    );
    assert_eq!(config["loop"]["overseerBriefingTemplate"], "project");
    assert_eq!(config["hosted"], global["hosted"]);
    assert_eq!(config["installs"], global["installs"]);
}

#[test]
fn normalizes_worktree_cleanup_fields() {
    let config = merge_config_layers(
        None,
        Some(&json!({
            "worktrees": {
                "cacheCleanupDirs": "node_modules",
                "cacheCleanupEnabled": "yes",
                "cacheCleanupApply": "yes",
                "cacheCleanupIntervalMs": -1,
                "cacheCleanupInitialDelayMs": 42.9
            }
        })),
    );

    assert_eq!(
        config["worktrees"],
        json!({
            "baseDir": ".aimux/worktrees",
            "cacheCleanupDirs": ["node_modules", ".next"],
            "cacheCleanupEnabled": true,
            "cacheCleanupApply": false,
            "cacheCleanupIntervalMs": 86_400_000,
            "cacheCleanupInitialDelayMs": 42
        })
    );

    let array_config = merge_config_layers(None, Some(&json!({ "worktrees": [] })));
    assert_eq!(array_config["worktrees"], default_config()["worktrees"]);
}

#[test]
fn normalizes_loop_template_but_preserves_javascript_array_behavior() {
    let invalid = merge_config_layers(
        None,
        Some(&json!({ "loop": { "overseerBriefingTemplate": 42 } })),
    );
    assert!(invalid["loop"].get("overseerBriefingTemplate").is_none());

    let array = merge_config_layers(None, Some(&json!({ "loop": [] })));
    assert_eq!(array["loop"], json!([]));
}

#[test]
fn normalizes_scribe_string_object_and_disabled_forms() {
    let object = merge_config_layers(
        None,
        Some(&json!({
            "scribe": {
                "defaultAgent": {
                    "tool": "  claude  ",
                    "extraArgs": ["--model", "sonnet"],
                    "env": { "AIMUX_TEST_MODEL": "sonnet" }
                }
            }
        })),
    );
    assert_eq!(
        object["scribe"]["defaultAgent"],
        json!({
            "tool": "claude",
            "extraArgs": ["--model", "sonnet"],
            "env": { "AIMUX_TEST_MODEL": "sonnet" }
        })
    );

    let invalid_options = merge_config_layers(
        None,
        Some(&json!({
            "scribe": {
                "defaultAgent": {
                    "tool": "codex",
                    "extraArgs": ["valid", 1],
                    "env": { "VALID": "yes", "INVALID": false }
                }
            }
        })),
    );
    assert_eq!(
        invalid_options["scribe"]["defaultAgent"],
        json!({ "tool": "codex" })
    );

    for disabled in [json!(null), json!(false), json!("   "), json!(42)] {
        let config = merge_config_layers(
            None,
            Some(&json!({ "scribe": { "defaultAgent": disabled } })),
        );
        assert!(config["scribe"]["defaultAgent"].is_null());
    }
}

#[test]
fn normalizes_expose_defaults_and_valid_overrides() {
    let invalid = merge_config_layers(
        None,
        Some(&json!({
            "expose": { "initialScope": "somewhere", "hotSnapshotsEnabled": "yes" }
        })),
    );
    assert_eq!(invalid["expose"], default_config()["expose"]);

    let valid = merge_config_layers(
        None,
        Some(&json!({
            "expose": { "initialScope": "global", "hotSnapshotsEnabled": false }
        })),
    );
    assert_eq!(
        valid["expose"],
        json!({ "initialScope": "global", "hotSnapshotsEnabled": false })
    );

    let array = merge_config_layers(None, Some(&json!({ "expose": [] })));
    assert_eq!(array["expose"], default_config()["expose"]);
}

#[test]
fn migrates_stale_builtin_resume_args_and_preserves_fallbacks() {
    let config = merge_config_layers(
        None,
        Some(&json!({
            "tools": {
                "claude": { "resumeArgs": ["--continue"] },
                "codex": { "resumeArgs": ["resume", "--last"] }
            }
        })),
    );

    assert_eq!(
        config["tools"]["claude"]["resumeArgs"],
        json!(["--resume", "{sessionId}"])
    );
    assert_eq!(
        config["tools"]["claude"]["resumeFallback"],
        json!(["--continue"])
    );
    assert_eq!(
        config["tools"]["codex"]["resumeArgs"],
        json!(["resume", "{sessionId}"])
    );
    assert_eq!(
        config["tools"]["codex"]["resumeFallback"],
        json!(["resume", "--last"])
    );
}

#[test]
fn resume_normalization_preserves_explicit_fallbacks_and_stale_opt_outs() {
    let explicit_fallbacks = merge_config_layers(
        None,
        Some(&json!({
            "tools": {
                "claude": {
                    "resumeArgs": ["--continue"],
                    "resumeFallback": ["claude-explicit"]
                },
                "codex": {
                    "resumeArgs": ["resume", "--last"],
                    "resumeFallback": ["codex-explicit"]
                }
            }
        })),
    );
    assert_eq!(
        explicit_fallbacks["tools"]["claude"]["resumeFallback"],
        json!(["claude-explicit"])
    );
    assert_eq!(
        explicit_fallbacks["tools"]["codex"]["resumeFallback"],
        json!(["codex-explicit"])
    );

    let opted_out = merge_config_layers(
        None,
        Some(&json!({
            "tools": {
                "claude": {
                    "resumeArgs": ["--continue"],
                    "resumeByBackendSessionId": false
                },
                "codex": {
                    "resumeArgs": ["resume", "--last"],
                    "resumeByBackendSessionId": false
                }
            }
        })),
    );
    assert_eq!(
        opted_out["tools"]["claude"]["resumeArgs"],
        json!(["--continue"])
    );
    assert_eq!(
        opted_out["tools"]["codex"]["resumeArgs"],
        json!(["resume", "--last"])
    );
    assert_eq!(
        opted_out["tools"]["claude"]["resumeByBackendSessionId"],
        false
    );
    assert_eq!(
        opted_out["tools"]["codex"]["resumeByBackendSessionId"],
        false
    );
}

#[test]
fn exact_claude_resume_is_backend_session_resumable() {
    let config = merge_config_layers(
        None,
        Some(&json!({
            "tools": {
                "claude": {
                    "sessionIdFlag": ["--session-id", "{sessionId}"],
                    "resumeArgs": ["--resume", "{sessionId}"],
                    "resumeByBackendSessionId": false
                }
            }
        })),
    );

    assert_eq!(config["tools"]["claude"]["resumeByBackendSessionId"], true);
}

#[test]
#[should_panic(expected = "a.every is not a function")]
fn malformed_builtin_resume_args_throw_like_javascript_when_length_matches() {
    let _ = merge_config_layers(
        None,
        Some(&json!({
            "tools": {
                "codex": {
                    "command": "codex",
                    "resumeArgs": "xx"
                }
            }
        })),
    );
}

#[test]
#[should_panic(expected = "args?.some is not a function")]
fn malformed_claude_session_id_flag_throws_like_javascript() {
    let _ = merge_config_layers(
        None,
        Some(&json!({
            "tools": {
                "claude": {
                    "command": "claude",
                    "sessionIdFlag": "x",
                    "resumeArgs": ["--resume", "{sessionId}"]
                }
            }
        })),
    );
}

#[test]
#[should_panic(expected = "Cannot read properties of null")]
fn null_tools_config_throws_like_javascript() {
    let _ = merge_config_layers(None, Some(&json!({ "tools": null })));
}

#[test]
fn leaves_unknown_and_custom_tool_resume_args_unchanged() {
    let config = merge_config_layers(
        None,
        Some(&json!({
            "tools": {
                "claude": { "resumeArgs": ["--custom-continue"] },
                "codex": { "resumeArgs": ["resume", "custom"] },
                "codex-custom": {
                    "command": "codex",
                    "args": [],
                    "enabled": true,
                    "resumeArgs": ["resume", "--last"]
                }
            }
        })),
    );

    assert_eq!(
        config["tools"]["claude"]["resumeArgs"],
        json!(["--custom-continue"])
    );
    assert_eq!(
        config["tools"]["codex"]["resumeArgs"],
        json!(["resume", "custom"])
    );
    assert_eq!(
        config["tools"]["codex-custom"]["resumeArgs"],
        json!(["resume", "--last"])
    );
}
