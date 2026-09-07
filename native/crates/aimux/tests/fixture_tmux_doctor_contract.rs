use serde::Deserialize;
use serde_json::Value;

const TMUX_DOCTOR: &str = include_str!("../../../../testdata/contracts/v1/tmux/doctor.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    source: String,
    case_count: usize,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    source: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
#[ignore = "checklist: tmux doctor report and repair APIs are behind the tmux*/daemon_* ownership fence"]
fn fixture_tmux_doctor_contract_is_captured() {
    let contract: Contract = serde_json::from_str(TMUX_DOCTOR).expect("tmux doctor fixture parses");
    assert_eq!(contract.source, "src/tmux/doctor.test.ts");
    assert_eq!(contract.case_count, 4);
    assert_eq!(contract.cases.len(), contract.case_count);

    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, contract.source);
        assert!(matches!(
            case.api.as_str(),
            "buildTmuxDoctorReport" | "renderTmuxDoctorReport" | "repairTmuxRuntime"
        ));
        assert!(!case.input.is_null());
        assert!(!case.output.is_null());
    }
}
