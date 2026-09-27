//! The CLI half of the cross-surface project-liveness check.
//!
//! AGENTS.md "One Answer, Many Surfaces": a per-surface test passes happily
//! while the surfaces disagree, which is exactly how that class survives. This
//! reads the same fixture as `app/lib/project-picker.cross-surface.test.ts`, so
//! a surface that changes its rule alone fails here.

use aimux::core_text::render_core_projects_list_lines;
use serde_json::Value;

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/project-liveness/surfaces.json");

#[test]
fn the_cli_renders_the_shared_liveness_answer() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture parses");
    let cases = fixture["cases"].as_array().expect("cases array");
    assert!(!cases.is_empty(), "the fixture must carry cases");

    let projects = Value::Array(
        cases
            .iter()
            .map(|case| case["project"].clone())
            .collect::<Vec<_>>(),
    );
    let lines = render_core_projects_list_lines(&projects);
    assert_eq!(lines.len(), cases.len());

    for (line, case) in lines.iter().zip(cases) {
        let name = case["project"]["name"].as_str().expect("name");
        let path = case["project"]["path"].as_str().expect("path");
        let expected_word = case["cliWord"].as_str().expect("cliWord");
        assert_eq!(
            line,
            &format!("{name}  {expected_word}  {path}"),
            "{name}: {}",
            case["why"].as_str().unwrap_or_default()
        );
    }
}

#[test]
fn every_liveness_answer_is_covered_by_the_fixture() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture parses");
    let cases = fixture["cases"].as_array().expect("cases array");
    let words: Vec<&str> = cases
        .iter()
        .filter_map(|case| case["cliWord"].as_str())
        .collect();
    for required in ["live", "idle", "unknown"] {
        assert!(
            words.contains(&required),
            "the fixture must exercise {required}; a surface can only be pinned against answers it is given"
        );
    }
    assert!(
        cases
            .iter()
            .any(|case| case["project"].get("dashboardAlive").is_none()),
        "the fixture must include a project with the field absent, not only null"
    );
}
