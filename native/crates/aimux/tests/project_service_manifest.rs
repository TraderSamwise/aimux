use aimux::project_service_manifest::{
    PROJECT_SERVICE_API_VERSION, ProjectServiceManifest, build_stamp_generation,
    compute_build_stamp, is_stale_against_daemon, manifests_match, project_service_artifact_paths,
    project_service_artifact_paths_with_native_candidates, project_service_capabilities,
    resolve_artifact, should_keep_unresponsive_daemon,
};
use serde_json::{Value, json};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_dir(label: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos()
    ));
    fs::create_dir_all(&path).expect("create temp directory");
    path
}

fn expected_manifest() -> ProjectServiceManifest {
    serde_json::from_str(include_str!(
        "../../../../testdata/contracts/v1/project-service-manifest/manifest.json"
    ))
    .expect("valid manifest fixture")
}

#[test]
fn keeps_api_version_and_capability_schema_stable() {
    let expected = expected_manifest();
    assert_eq!(PROJECT_SERVICE_API_VERSION, 5);
    assert_eq!(expected.api_version, PROJECT_SERVICE_API_VERSION);
    assert_eq!(expected.capabilities, project_service_capabilities());
    assert!(manifests_match(
        &expected,
        Some(&serde_json::to_value(&expected).unwrap())
    ));
}

#[test]
fn manifest_matching_requires_every_current_capability_and_exact_build() {
    let expected = expected_manifest();
    let missing_capability = json!({
        "apiVersion": 5,
        "buildStamp": expected.build_stamp,
        "capabilities": { "parsedAgentOutput": true }
    });
    let stale_build = json!({
        "apiVersion": 5,
        "buildStamp": "old-build",
        "capabilities": expected.capabilities
    });
    assert!(!manifests_match(&expected, None));
    assert!(!manifests_match(&expected, Some(&missing_capability)));
    assert!(!manifests_match(&expected, Some(&stale_build)));
    assert!(manifests_match(
        &expected,
        Some(&json!({
            "apiVersion": "5",
            "buildStamp": expected.build_stamp,
            "capabilities": expected.capabilities,
            "futureCapability": true
        }))
    ));
}

#[test]
fn build_stamp_uses_compiled_artifacts_when_present_and_sha1_content_suffix() {
    let root = temp_dir("manifest-artifacts");
    fs::write(root.join("launcher-bin.ts"), "source-launcher").unwrap();
    fs::write(root.join("main.ts"), "source-main").unwrap();
    let paths = project_service_artifact_paths(&root).unwrap();
    assert!(paths.iter().all(|path| path.extension().unwrap() == "ts"));
    let stamp = compute_build_stamp(&paths).unwrap();
    assert!(stamp.contains('.'));
    assert_eq!(stamp.rsplit_once('-').unwrap().1.len(), 12);

    fs::write(root.join("main.js"), "compiled-main").unwrap();
    assert_eq!(
        resolve_artifact(root.join("main.js"), root.join("main.ts")).unwrap(),
        root.join("main.js")
    );
    fs::remove_dir_all(root).expect("remove temp directory");
}

#[test]
fn build_stamp_prefers_native_runtime_artifact_when_present() {
    let root = temp_dir("manifest-native-artifact");
    fs::write(root.join("launcher-bin.js"), "stale-launcher").unwrap();
    fs::write(root.join("main.js"), "stale-main").unwrap();
    let native = root.join("native/darwin-arm64/aimux");
    fs::create_dir_all(native.parent().unwrap()).unwrap();
    fs::write(&native, "native-binary").unwrap();

    let paths =
        project_service_artifact_paths_with_native_candidates(&root, std::slice::from_ref(&native))
            .unwrap();
    assert_eq!(paths, vec![native]);
    let stamp = compute_build_stamp(&paths).unwrap();
    assert!(!stamp.contains('.'));
    assert_eq!(stamp.rsplit_once('-').unwrap().1.len(), 12);

    fs::remove_dir_all(root).expect("remove temp directory");
}

#[test]
fn preserves_staleness_and_liveness_decisions() {
    let older = json!("1786180016000.1786180016000-35f055a7caff");
    let newer = json!("1786237306000.1786237306000-35f055a7caff");
    assert_eq!(
        build_stamp_generation(Some(&older)),
        Some(1_786_180_016_000)
    );
    for stamp in [
        Value::Null,
        json!(""),
        json!("-onlyhash"),
        json!("nan.nan-abc"),
        json!("0.0-abc"),
        json!(false),
        json!({ "stamp": "1786180016000.0-abc" }),
    ] {
        assert_eq!(build_stamp_generation(Some(&stamp)), None);
    }
    assert_eq!(build_stamp_generation(None), None);
    assert!(is_stale_against_daemon(Some(&newer), Some(&older)));
    assert!(!is_stale_against_daemon(Some(&older), Some(&newer)));
    assert!(!is_stale_against_daemon(Some(&newer), None));
    assert!(should_keep_unresponsive_daemon(None, true));
    assert!(should_keep_unresponsive_daemon(Some(true), true));
    assert!(!should_keep_unresponsive_daemon(Some(false), true));
    assert!(!should_keep_unresponsive_daemon(None, false));
}

#[test]
fn malformed_json_manifest_is_not_a_match() {
    let expected = expected_manifest();
    assert!(!manifests_match(
        &expected,
        Some(&Value::String("manifest".into()))
    ));
}
