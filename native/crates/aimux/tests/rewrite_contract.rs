use aimux::{contract_manifest, rewrite_status};

#[test]
fn contract_manifest_keeps_zero_node_end_state_visible() {
    let manifest = contract_manifest();
    assert_eq!(manifest.version, 1);
    assert!(manifest.rule.contains("committed corpora"));
    assert!(manifest.areas.iter().any(|area| area.id == "tmux-runtime"));
    assert!(manifest.areas.iter().any(|area| area.id == "dashboard-tui"));
}

#[test]
fn rewrite_status_tracks_translation_first_phases() {
    let status = rewrite_status();
    assert_eq!(status.version, 2);
    assert!(status.strategy.contains("translation first"));
    assert!(status.end_state.contains("zero Node"));
    assert_eq!(status.progress_estimate_percent, 92);
    assert!(status.active_slice.contains("front-door"));
    assert!(
        status
            .checkpoints
            .iter()
            .any(|checkpoint| checkpoint.contains("runtime event route"))
    );
    assert!(
        status
            .checkpoints
            .iter()
            .any(|checkpoint| checkpoint.contains("production dashboard launch default"))
    );
    assert!(
        status
            .checkpoints
            .iter()
            .any(|checkpoint| checkpoint.contains("retired TypeScript hot-path graph"))
    );
    assert_eq!(status.phases.len(), 9);
    assert_eq!(status.phases[0].id, "phase-0");
    assert_eq!(status.phases[1].status, aimux::PhaseStatus::Complete);
    assert_eq!(status.phases[7].status, aimux::PhaseStatus::Complete);
    assert_eq!(status.phases[8].id, "phase-8");
    assert_eq!(status.phases[8].status, aimux::PhaseStatus::Complete);
}
