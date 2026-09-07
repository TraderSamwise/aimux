use serde::Deserialize;
use serde_json::Value;

const SRC_INTEGRATION_SURFACES: &str =
    include_str!("../../../../testdata/contracts/v1/integration/src-surfaces.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    sources: Vec<String>,
    subject: String,
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
#[ignore = "checklist: TypeScript src integration surfaces span core_cli*, daemon_*, hosted listener, and project_service/routes/ ownership fences"]
fn fixture_src_integration_surfaces_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(SRC_INTEGRATION_SURFACES).expect("src integration fixture parses");
    assert_eq!(
        contract.subject,
        "src integration surface request/response contracts"
    );
    assert_eq!(contract.case_count, 7);
    assert_eq!(contract.cases.len(), contract.case_count);
    for source in [
        "src/core-cli.test.ts",
        "src/core-project-actor.test.ts",
        "src/daemon.test.ts",
        "src/full/hosted-server.test.ts",
        "src/metadata-server.test.ts",
        "src/metadata-server.interaction.test.ts",
    ] {
        assert!(contract.sources.contains(&source.to_string()));
    }

    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert!(
            contract.sources.contains(&case.source),
            "case {} source {} is not declared",
            case.id,
            case.source
        );
        assert!(!case.api.is_empty());
        assert!(!case.input.is_null());
        assert!(!case.output.is_null());
    }
}
