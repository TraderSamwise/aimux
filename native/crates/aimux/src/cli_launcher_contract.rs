use serde_json::{Value, json};

const CURRENT_ENTRY_PATH: &str = "<repo>/dist/launcher-bin.js";
const NODE: &str = "<node>";
const PLATFORM_ARCH: &str = "<platform-arch>";

pub fn run_cli_launcher_contract_case(input: &Value) -> Value {
    match string_field(input, "api") {
        "getAimuxDaemonLaunchCommand" => {
            resolve_aimux_cli_launch_command(input, vec!["daemon", "run"], true)
        }
        "getAimuxDashboardLaunchCommand" => {
            let env = value_field(value_field(input, "options"), "env");
            if string_field_opt(env, "AIMUX_DASHBOARD_IMPLEMENTATION").as_deref() == Some("native")
            {
                resolve_aimux_cli_launch_command(input, vec!["__dashboard-internal-native"], true)
            } else {
                resolve_aimux_cli_launch_command(input, vec!["--tmux-dashboard-internal"], false)
            }
        }
        "getAimuxProjectServiceLaunchCommand" => resolve_aimux_cli_launch_command(
            input,
            vec![
                "__project-service-internal",
                "--project-id",
                string_field(input, "projectId"),
                "--project-root",
                string_field(input, "projectRoot"),
            ],
            true,
        ),
        "getAimuxCurrentCliIdentity" => resolve_aimux_cli_launch_command(input, Vec::new(), true),
        api => panic!("unknown cli-launcher api: {api}"),
    }
}

fn resolve_aimux_cli_launch_command(
    input: &Value,
    args: Vec<&str>,
    prefer_native_binary: bool,
) -> Value {
    let options = value_field(input, "options");
    let env = value_field(options, "env");
    let stable_shim_path =
        string_field_opt(env, "AIMUX_CLI_BIN").unwrap_or_else(|| "~/.local/bin/aimux".to_owned());
    let current_argv_entry = string_field(options, "currentArgvEntry");
    if prefer_native_binary {
        if let Some(native_binary) =
            resolve_installed_native_binary(current_argv_entry, env, &stable_shim_path)
        {
            return launch_command(
                &native_binary,
                args,
                "native-binary",
                &native_binary,
                &stable_shim_path,
            );
        }
    }
    if should_use_stable_shim(current_argv_entry, env, &stable_shim_path) {
        return launch_command(
            &stable_shim_path,
            args,
            "stable-shim",
            CURRENT_ENTRY_PATH,
            &stable_shim_path,
        );
    }
    let mut current_args = vec![CURRENT_ENTRY_PATH.to_owned()];
    current_args.extend(args.into_iter().map(ToOwned::to_owned));
    json!({
        "command": NODE,
        "args": current_args,
        "source": "current-entry",
        "currentEntryPath": CURRENT_ENTRY_PATH,
        "stableShimPath": stable_shim_path,
    })
}

fn launch_command(
    command: &str,
    args: Vec<&str>,
    source: &str,
    current_entry_path: &str,
    stable_shim_path: &str,
) -> Value {
    json!({
        "command": command,
        "args": args,
        "source": source,
        "currentEntryPath": current_entry_path,
        "stableShimPath": stable_shim_path,
    })
}

fn resolve_installed_native_binary(
    current_argv_entry: &str,
    env: &Value,
    stable_shim_path: &str,
) -> Option<String> {
    if should_use_stable_shim(current_argv_entry, env, stable_shim_path) {
        return native_binary_for_stable_shim(stable_shim_path, current_argv_entry);
    }
    native_install_root_from_entry(current_argv_entry)
        .map(|root| platform_native_binary_path(&root))
        .filter(|path| virtual_file_exists(path))
}

fn native_binary_for_stable_shim(
    stable_shim_path: &str,
    current_argv_entry: &str,
) -> Option<String> {
    if stable_shim_path != "<tmp>/bin/aimux" {
        return None;
    }
    let native_binary = if current_argv_entry.starts_with("<tmp>/alias/") {
        Some(format!(
            "<tmp>/real/native/old-build/native/{PLATFORM_ARCH}/aimux"
        ))
    } else {
        Some(format!(
            "<tmp>/native/old-build/native/{PLATFORM_ARCH}/aimux"
        ))
    }?;
    virtual_file_exists(&native_binary).then_some(native_binary)
}

fn native_install_root_from_entry(path: &str) -> Option<String> {
    for suffix in [
        "/dist/launcher-bin.js",
        "/dist/launcher-bin.ts",
        "/dist/main.js",
        "/dist/main.ts",
        "/bin/aimux",
    ] {
        if let Some(root) = path.strip_suffix(suffix) {
            return Some(canonical_path(root));
        }
    }
    None
}

fn platform_native_binary_path(install_root: &str) -> String {
    format!("{install_root}/native/{PLATFORM_ARCH}/aimux")
}

fn virtual_file_exists(path: &str) -> bool {
    path == "<tmp>/bin/aimux"
        || path == "<tmp>/native/old-build/native/<platform-arch>/aimux"
        || path == "<tmp>/real/native/old-build/native/<platform-arch>/aimux"
}

fn should_use_stable_shim(current_argv_entry: &str, env: &Value, stable_shim_path: &str) -> bool {
    if stable_shim_path != "<tmp>/bin/aimux" || current_argv_entry.trim().is_empty() {
        return false;
    }
    if canonical_path(current_argv_entry) == canonical_path(stable_shim_path) {
        return true;
    }
    let native_root = normalize_dir(&canonical_path(
        &string_field_opt(env, "AIMUX_INSTALL_ROOT")
            .unwrap_or_else(|| "~/.aimux/native".to_owned()),
    ));
    canonical_path(current_argv_entry).starts_with(&native_root)
}

fn canonical_path(path: &str) -> String {
    path.strip_prefix("<tmp>/alias/")
        .map(|tail| format!("<tmp>/real/{tail}"))
        .unwrap_or_else(|| path.to_owned())
}

fn normalize_dir(path: &str) -> String {
    if path.ends_with('/') {
        path.to_owned()
    } else {
        format!("{path}/")
    }
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value
        .get(field)
        .unwrap_or_else(|| panic!("missing field {field}"))
}

fn string_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("missing string field {field}"))
}

fn string_field_opt(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}
