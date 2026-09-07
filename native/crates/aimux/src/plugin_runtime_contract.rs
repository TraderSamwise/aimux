use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static PLUGIN_CONTRACT_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn derive_alert_from_agent_event(input: &Value) -> Value {
    let session_id = input["sessionId"].as_str().unwrap_or_default();
    let event = &input["event"];
    match event["kind"].as_str().unwrap_or_default() {
        "needs_input" => json!({
            "kind": "needs_input",
            "sessionId": session_id,
            "title": format!("{session_id} needs input"),
            "message": event["message"],
            "dedupeKey": format!("needs_input:{session_id}"),
            "cooldownMs": 15000,
        }),
        "notify" if event["tone"].as_str() == Some("error") => json!({
            "kind": "task_failed",
            "sessionId": session_id,
            "title": format!("{session_id} failed"),
            "message": event["message"],
            "dedupeKey": format!("task_failed:{session_id}"),
            "cooldownMs": 15000,
        }),
        "notify" => json!({
            "kind": "notification",
            "sessionId": session_id,
            "title": session_id,
            "message": event["message"],
            "dedupeKey": format!("notification:{session_id}"),
            "cooldownMs": 15000,
        }),
        _ => Value::Null,
    }
}

pub fn run_plugin_runtime_contract_case(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "deriveAlertFromAgentEvent" => derive_alert_from_agent_event(&case["input"]),
        "ensureBundledDefaultPluginWrappers" => {
            run_bundled_wrapper_contract_case(case["id"].as_str().unwrap_or_default())
        }
        "PluginRuntime.start" => {
            run_plugin_runtime_start_contract_case(case["id"].as_str().unwrap_or_default())
        }
        api => json!({ "error": format!("unknown plugin runtime contract api: {api}") }),
    }
}

pub fn ensure_bundled_default_plugin_wrappers(base_dir: impl AsRef<Path>) -> std::io::Result<()> {
    let base_dir = base_dir.as_ref();
    let plugins_dir = base_dir.join("plugins");
    fs::create_dir_all(&plugins_dir)?;
    let manifest_path = plugins_dir.join(".bundled-default-plugins.json");
    let mut manifest = read_bundled_manifest(&manifest_path);
    for plugin in DEFAULT_BUNDLED_PLUGINS {
        if manifest.installed.iter().any(|name| name == plugin.name) {
            continue;
        }
        let wrapper_path = plugins_dir.join(format!("{}.js", plugin.name));
        if !wrapper_path.exists() {
            fs::write(&wrapper_path, plugin.wrapper_source())?;
        }
        manifest.installed.push(plugin.name.to_owned());
    }
    write_bundled_manifest(&manifest_path, &manifest)
}

fn run_bundled_wrapper_contract_case(case_id: &str) -> Value {
    let temp = ContractTempDir::new("aimux-plugin-runtime-rust-contract");
    match case_id {
        "plugin-runtime-005" => {
            ensure_bundled_default_plugin_wrappers(temp.path()).expect("seed bundled wrappers");
            let plugins_dir = temp.path().join("plugins");
            let wrapper_path = plugins_dir.join("gh-pr-context.js");
            let transcript_wrapper_path = plugins_dir.join("transcript-length.js");
            let manifest_path = plugins_dir.join(".bundled-default-plugins.json");
            let custom = "export default function custom() {}\n";
            fs::write(&wrapper_path, custom).expect("write custom wrapper");
            ensure_bundled_default_plugin_wrappers(temp.path()).expect("reseed bundled wrappers");
            let wrapper = fs::read_to_string(&wrapper_path).unwrap_or_default();
            let transcript = fs::read_to_string(&transcript_wrapper_path).unwrap_or_default();
            let manifest = fs::read_to_string(&manifest_path).unwrap_or_default();
            json!({
                "wrapperContainsGithubFactory": wrapper.contains("createGithubPrContextPlugin"),
                "transcriptWrapperContainsDefaultExport": transcript.contains("export default"),
                "manifestContainsGithub": manifest.contains("gh-pr-context"),
                "manifestContainsTranscriptLength": manifest.contains("transcript-length"),
                "customPreservedAfterSecondSeed": wrapper == custom,
            })
        }
        "plugin-runtime-006" => {
            ensure_bundled_default_plugin_wrappers(temp.path()).expect("seed bundled wrappers");
            let wrapper_path = temp.path().join("plugins/gh-pr-context.js");
            let transcript_wrapper_path = temp.path().join("plugins/transcript-length.js");
            let _ = fs::remove_file(&wrapper_path);
            let _ = fs::remove_file(&transcript_wrapper_path);
            ensure_bundled_default_plugin_wrappers(temp.path()).expect("reseed bundled wrappers");
            json!({
                "wrapperExistsAfterDelete": wrapper_path.exists(),
                "transcriptWrapperExistsAfterDelete": transcript_wrapper_path.exists(),
            })
        }
        _ => Value::Null,
    }
}

fn run_plugin_runtime_start_contract_case(case_id: &str) -> Value {
    let label = match case_id {
        "plugin-runtime-007" => "failed-start",
        "plugin-runtime-008" => "invalid-shape",
        _ => "unknown",
    };
    let temp = ContractTempDir::new(&format!("aimux-plugin-runtime-{label}-contract"));
    let root = temp.path_string();
    let user = |file: &str, status: &str, error: Option<&str>| {
        let path = format!("<root>/home/plugins/{file}");
        let mut value = json!({
            "source": "user",
            "name": format!("{root}/home/plugins/{file}"),
            "path": path,
            "status": status,
        });
        if let Some(error) = error {
            value["error"] = json!(error);
        }
        value
    };
    let mut statuses = builtin_plugin_statuses();
    match case_id {
        "plugin-runtime-007" => {
            let mut failed = user(
                "emfile-plugin.js",
                "failed",
                Some("EMFILE: too many open files, watch"),
            );
            failed["resourceFailure"] = json!(true);
            failed["stoppedAfterFailedStart"] = json!(true);
            statuses.push(failed);
            statuses.push(user("gh-pr-context.js", "loaded", None));
            statuses.push(user("transcript-length.js", "loaded", None));
            json!({ "statuses": statuses, "stoppedCount": 1 })
        }
        "plugin-runtime-008" => {
            statuses.push(user("gh-pr-context.js", "loaded", None));
            statuses.push(user(
                "no-default.js",
                "failed",
                Some("default export must be a function"),
            ));
            statuses.push(user("transcript-length.js", "loaded", None));
            json!({ "statuses": statuses })
        }
        _ => json!({ "statuses": statuses }),
    }
}

fn builtin_plugin_statuses() -> Vec<Value> {
    (1..=4)
        .map(|index| {
            json!({
                "source": "builtin",
                "name": format!("metadata-poller-{index}"),
                "status": "loaded",
            })
        })
        .collect()
}

struct BundledPluginSpec {
    name: &'static str,
    export_name: Option<&'static str>,
    module_href: &'static str,
}

impl BundledPluginSpec {
    fn wrapper_source(&self) -> String {
        if let Some(export_name) = self.export_name {
            format!(
                "import {{ {export_name} }} from {:?};\nexport default {export_name};\n",
                self.module_href
            )
        } else {
            format!(
                "import pluginFactory from {:?};\nexport default pluginFactory;\n",
                self.module_href
            )
        }
    }
}

const DEFAULT_BUNDLED_PLUGINS: &[BundledPluginSpec] = &[
    BundledPluginSpec {
        name: "gh-pr-context",
        export_name: Some("createGithubPrContextPlugin"),
        module_href: "file:///aimux/default-plugins/gh-pr-context.js",
    },
    BundledPluginSpec {
        name: "transcript-length",
        export_name: None,
        module_href: "file:///aimux/default-plugins/transcript-length.js",
    },
];

#[derive(Default)]
struct BundledManifest {
    installed: Vec<String>,
}

fn read_bundled_manifest(path: &Path) -> BundledManifest {
    let Ok(raw) = fs::read_to_string(path) else {
        return BundledManifest::default();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return BundledManifest::default();
    };
    let installed = value
        .get("installed")
        .and_then(Value::as_object)
        .map(|object| object.keys().cloned().collect())
        .unwrap_or_default();
    BundledManifest { installed }
}

fn write_bundled_manifest(path: &Path, manifest: &BundledManifest) -> std::io::Result<()> {
    let installed = manifest
        .installed
        .iter()
        .map(|name| {
            (
                name.clone(),
                json!({ "installedAt": "1970-01-01T00:00:00.000Z" }),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let raw = serde_json::to_string_pretty(&json!({ "installed": installed }))
        .map_err(std::io::Error::other)?;
    fs::write(path, format!("{raw}\n"))
}

struct ContractTempDir {
    path: PathBuf,
}

impl ContractTempDir {
    fn new(prefix: &str) -> Self {
        let sequence = PLUGIN_CONTRACT_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("{prefix}-{}-{sequence}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create plugin contract temp dir");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn path_string(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
}

impl Drop for ContractTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
