use std::fs;
use std::path::PathBuf;

use aimux::atomic_write::{
    atomic_write_with_mode, quarantine_corrupt_file, write_json_atomic, write_text_atomic,
};
use serde_json::{Value, json};

const ATOMIC_WRITE: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-state/atomic-write.json");

#[test]
fn fixture_atomic_write_matches_typescript() {
    let contract: Value =
        serde_json::from_str(ATOMIC_WRITE).expect("valid runtime-state/atomic-write fixture");
    let cases = contract["cases"].as_array().expect("atomic-write cases");
    assert_eq!(cases.len(), 8, "unexpected atomic-write case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = atomic_write_contract(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} runtime-state/atomic-write parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn atomic_write_contract(case: &Value) -> Value {
    with_dir(|dir| match case["api"].as_str().unwrap_or_default() {
        "atomicWrite" => {
            let target = dir.join(case["input"]["path"].as_str().unwrap_or("file.txt"));
            aimux::atomic_write::atomic_write(
                &target,
                case["input"]["data"].as_str().unwrap_or_default(),
            )
            .expect("atomic write");
            json!({
                "content": fs::read_to_string(&target).expect("read target"),
                "tempFiles": list_names(target.parent().expect("target parent"), |name| name.contains(".tmp")),
            })
        }
        "writeJsonAtomic" => {
            let target = dir.join(case["input"]["path"].as_str().unwrap_or("state.json"));
            write_json_atomic(&target, &case["input"]["value"]).expect("write json");
            let raw = fs::read_to_string(&target).expect("read json");
            json!({
                "endsWithNewline": raw.ends_with('\n'),
                "parsed": serde_json::from_str::<Value>(&raw).expect("parse json"),
            })
        }
        "writeTextAtomic" => {
            let target = dir.join(case["input"]["path"].as_str().unwrap_or("text.txt"));
            write_text_atomic(&target, case["input"]["text"].as_str().unwrap_or_default())
                .expect("write text");
            json!(fs::read_to_string(target).expect("read text"))
        }
        "atomicWriteMode" => {
            let target = dir.join(case["input"]["path"].as_str().unwrap_or("auth.json"));
            atomic_write_with_mode(
                &target,
                case["input"]["data"].as_str().unwrap_or_default(),
                Some(case["input"]["mode"].as_u64().unwrap_or(0) as u32),
            )
            .expect("write with mode");
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                fs::metadata(&target)
                    .expect("metadata")
                    .permissions()
                    .mode()
                    & 0o777
            };
            #[cfg(not(unix))]
            let mode = case["input"]["mode"].as_u64().unwrap_or(0) as u32;
            json!({ "mode": mode })
        }
        "overwriteJsonAtomic" => {
            let target = dir.join(case["input"]["path"].as_str().unwrap_or("f.json"));
            for value in case["input"]["values"].as_array().into_iter().flatten() {
                write_json_atomic(&target, value).expect("overwrite json");
            }
            let raw = fs::read_to_string(&target).expect("read overwritten json");
            json!({
                "exists": target.exists(),
                "parsed": serde_json::from_str::<Value>(&raw).expect("parse overwritten json"),
            })
        }
        "uniqueTempPath" => {
            let target = dir.join(case["input"]["path"].as_str().unwrap_or("file.txt"));
            let shared_tmp = PathBuf::from(format!("{}.tmp", target.to_string_lossy()));
            fs::create_dir_all(&shared_tmp).expect("occupy shared tmp");
            write_text_atomic(&target, case["input"]["text"].as_str().unwrap_or_default())
                .expect("write around occupied tmp");
            json!({
                "content": fs::read_to_string(&target).expect("read target"),
                "tempFileNames": list_names(target.parent().expect("target parent"), |name| name.ends_with(".tmp") && target.parent().expect("target parent").join(name).is_file()),
            })
        }
        "quarantineCorruptFile" => {
            let target = dir.join(case["input"]["path"].as_str().unwrap_or("state.json"));
            fs::write(&target, case["input"]["text"].as_str().unwrap_or_default())
                .expect("write corrupt file");
            let dest = quarantine_corrupt_file(&target).expect("quarantine corrupt file");
            json!({
                "destName": normalize_corrupt_name(dest.file_name().and_then(|name| name.to_str()).unwrap_or_default()),
                "targetExists": target.exists(),
                "quarantinedContent": fs::read_to_string(&dest).expect("read quarantined file"),
                "hasCorruptFile": !list_names(dir, |name| name.contains(".corrupt-")).is_empty(),
            })
        }
        "quarantineMissing" => json!(quarantine_corrupt_file(
            dir.join(case["input"]["path"].as_str().unwrap_or("missing.json"))
        )),
        _ => Value::Null,
    })
}

fn list_names(dir: &std::path::Path, predicate: impl Fn(&str) -> bool) -> Vec<String> {
    let mut names = fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| predicate(name))
        .collect::<Vec<_>>();
    names.sort();
    names
}

fn normalize_corrupt_name(name: &str) -> String {
    match name.find(".corrupt-") {
        Some(index) => format!("{}.corrupt-<ts:1>", &name[..index]),
        None => name.into(),
    }
}

fn with_dir(callback: impl FnOnce(&PathBuf) -> Value) -> Value {
    let dir = std::env::temp_dir().join(format!(
        "aimux-atomic-write-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos()
    ));
    fs::create_dir_all(&dir).expect("create temp dir");
    let result = callback(&dir);
    let _ = fs::remove_dir_all(&dir);
    result
}
