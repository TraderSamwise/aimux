use aimux::session_launch::{
    derive_aimux_session_id_from_backend_session_id, inject_codex_developer_instructions,
    summarize_launch_args,
};

#[test]
fn derives_stable_aimux_ids_from_backend_session_ids() {
    assert_eq!(
        derive_aimux_session_id_from_backend_session_id(
            "codex",
            "11111111-2222-3333-4444-555555555555",
            Vec::<String>::new(),
        ),
        "codex-111111"
    );
    assert_eq!(
        derive_aimux_session_id_from_backend_session_id(
            "claude",
            "11111111-2222-3333-4444-555555555555",
            ["claude-111111", "claude-1111111"],
        ),
        "claude-11111111"
    );
    let backend_session_id = "1111111111111111111111111111111111111111";
    let exhausted_prefix_ids = (0..11)
        .map(|index| format!("codex-{}", &backend_session_id[..index + 6]))
        .collect::<Vec<_>>();
    let hash_fallback = derive_aimux_session_id_from_backend_session_id(
        "codex",
        backend_session_id,
        exhausted_prefix_ids.clone(),
    );
    assert_eq!(
        derive_aimux_session_id_from_backend_session_id(
            "codex",
            backend_session_id,
            exhausted_prefix_ids
                .iter()
                .map(String::as_str)
                .chain(std::iter::once(hash_fallback.as_str())),
        ),
        format!("{hash_fallback}-2")
    );
}

#[test]
fn inserts_codex_developer_instructions_before_subcommands() {
    assert_eq!(
        inject_codex_developer_instructions(
            &["--model", "gpt-5", "resume", "abc"].map(str::to_owned),
            "developer_instructions",
            "stand",
        ),
        [
            "--model",
            "gpt-5",
            "-c",
            "developer_instructions=\"stand\"",
            "resume",
            "abc"
        ]
        .map(str::to_owned)
    );
    assert_eq!(
        inject_codex_developer_instructions(
            &[
                "--dangerously-bypass-approvals-and-sandbox",
                "--",
                "Explain",
            ]
            .map(str::to_owned),
            "developer_instructions",
            "stand",
        ),
        [
            "--dangerously-bypass-approvals-and-sandbox",
            "-c",
            "developer_instructions=\"stand\"",
            "--",
            "Explain",
        ]
        .map(str::to_owned)
    );
}

#[test]
fn redacts_sensitive_launch_arg_values_in_debug_summaries() {
    assert_eq!(
        summarize_launch_args(
            &[
                "--api-key",
                "sk-real-secret",
                "--model",
                "gpt-5",
                "--auth-token=real-token",
                "OPENAI_API_KEY=real-key",
                "PATH=/usr/bin",
            ]
            .map(str::to_owned)
        ),
        [
            "--api-key",
            "<redacted>",
            "--model",
            "gpt-5",
            "--auth-token=<redacted>",
            "OPENAI_API_KEY=<redacted>",
            "PATH=/usr/bin",
        ]
        .map(str::to_owned)
    );
}
