use serde_json::Value;

const DAEMON_STATE: &str =
    include_str!("../../../../testdata/contracts/v1/daemon-state/state.json");

#[test]
fn fixture_daemon_state_is_loaded() {
    let contract: Value = serde_json::from_str(DAEMON_STATE).expect("valid daemon state fixture");
    assert_eq!(contract["version"], 1);
    assert_eq!(
        contract["projects"]
            .as_object()
            .map(|projects| projects.len()),
        Some(3)
    );
}
