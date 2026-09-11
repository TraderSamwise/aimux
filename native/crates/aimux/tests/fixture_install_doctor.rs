use aimux::install_cleanup::{
    InstallCleanupCandidate, InstallCleanupItemResult, InstallCleanupItemStatus,
    InstallCleanupKept, InstallCleanupPlan, InstallCleanupRunResult, InstallKeepReason,
    render_install_cleanup_plan, render_install_cleanup_result,
};
use serde::Deserialize;
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/install-cleanup/doctor.json");

#[derive(Debug, Deserialize)]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn install_doctor_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("install-doctor fixture parses");
    assert_eq!(contract.cases.len(), 9);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

fn run_case(input: &Value) -> Value {
    match input["api"].as_str().unwrap_or_default() {
        "isInstallCleanupDryRun" => {
            json!(input["options"].get("fix").and_then(Value::as_bool) != Some(true))
        }
        "renderInstallCleanupPlan" => json!(render_install_cleanup_plan(&plan_from_value(
            &input["plan"]
        ))),
        "renderInstallCleanupResult" => json!(render_install_cleanup_result(&result_from_value(
            &input["result"]
        ))),
        api => panic!("unknown install-doctor api: {api}"),
    }
}

fn result_from_value(value: &Value) -> InstallCleanupRunResult {
    InstallCleanupRunResult {
        dry_run: value["dryRun"].as_bool().unwrap_or(false),
        plan: plan_from_value(&value["plan"]),
        results: array_field(value, "results")
            .iter()
            .map(item_result_from_value)
            .collect(),
        reclaimed_bytes: value["reclaimedBytes"].as_u64().unwrap_or_default(),
    }
}

fn item_result_from_value(value: &Value) -> InstallCleanupItemResult {
    InstallCleanupItemResult {
        name: string_field(value, "name").unwrap_or_default(),
        status: match string_field(value, "status").as_deref() {
            Some("removed") => InstallCleanupItemStatus::Removed,
            Some("failed") => InstallCleanupItemStatus::Failed,
            _ => InstallCleanupItemStatus::DryRun,
        },
        size_bytes: value["sizeBytes"].as_u64().unwrap_or_default(),
        error: string_field(value, "error"),
    }
}

fn plan_from_value(value: &Value) -> InstallCleanupPlan {
    InstallCleanupPlan {
        root: string_field(value, "root").unwrap_or_default(),
        current_install: string_field(value, "currentInstall"),
        retention_days: value["retentionDays"].as_u64().unwrap_or_default(),
        keep_recent: value["keepRecent"].as_u64().unwrap_or_default() as usize,
        references_complete: value["referencesComplete"].as_bool().unwrap_or(false),
        remove: array_field(value, "remove")
            .iter()
            .map(candidate_from_value)
            .collect(),
        keep: array_field(value, "keep")
            .iter()
            .map(kept_from_value)
            .collect(),
        reclaimable_bytes: value["reclaimableBytes"].as_u64().unwrap_or_default(),
    }
}

fn candidate_from_value(value: &Value) -> InstallCleanupCandidate {
    InstallCleanupCandidate {
        name: string_field(value, "name").unwrap_or_default(),
        path: string_field(value, "path").unwrap_or_default(),
        age_days: value["ageDays"].as_f64().unwrap_or_default(),
        size_bytes: value["sizeBytes"].as_u64().unwrap_or_default(),
    }
}

fn kept_from_value(value: &Value) -> InstallCleanupKept {
    InstallCleanupKept {
        name: string_field(value, "name").unwrap_or_default(),
        reason: match string_field(value, "reason").as_deref() {
            Some("in-use") => InstallKeepReason::InUse,
            Some("recent") => InstallKeepReason::Recent,
            Some("within-retention") => InstallKeepReason::WithinRetention,
            Some("references-unverified") => InstallKeepReason::ReferencesUnverified,
            Some("incomplete") => InstallKeepReason::Incomplete,
            _ => InstallKeepReason::CurrentInstall,
        },
    }
}

fn array_field<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}
