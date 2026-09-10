use aimux::attachment_store_contract::{
    attachment_store_contract, attachment_store_contract_is_supported,
};
use serde_json::{Value, json};

const ATTACHMENT_STORE: &str =
    include_str!("../../../../testdata/contracts/v1/attachments/store.json");

#[test]
fn fixture_attachment_store_matches_typescript() {
    let contract: Value =
        serde_json::from_str(ATTACHMENT_STORE).expect("valid attachment-store fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("attachment-store cases");
    assert_eq!(cases.len(), 33, "unexpected attachment-store case count");
    let mut failures = Vec::new();
    for case in cases {
        assert!(
            attachment_store_contract_is_supported(case),
            "unsupported attachment-store case: {}",
            case["id"]
        );
        let actual = attachment_store_contract(case);
        let expected = normalize_platform_path_spellings(case["output"].clone());
        let actual = normalize_platform_path_spellings(actual);
        if actual != expected {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "api": case["api"],
                "expected": expected,
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} attachment-store parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn normalize_platform_path_spellings(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(normalize_platform_path_spellings)
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, normalize_platform_path_spellings(value)))
                .collect(),
        ),
        Value::String(text) => Value::String(normalize_platform_path_text(&text)),
        value => value,
    }
}

fn normalize_platform_path_text(text: &str) -> String {
    let mut output = text.to_owned();
    for placeholder in ["<project>", "<temp>", "<scratch>", "<outside>"] {
        output = output.replace(&format!("/private{placeholder}"), placeholder);
    }
    for (macos, portable) in [
        ("/private/etc/", "/etc/"),
        ("/private/tmp/", "/tmp/"),
        ("/private/var/", "/var/"),
    ] {
        output = output.replace(macos, portable);
    }
    output
}
