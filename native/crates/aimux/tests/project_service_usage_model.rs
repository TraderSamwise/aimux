use aimux::project_service::usage_model::{
    UsageQuotaObservation, UsageState, claude_statusline_usage, codex_rate_limit_usage,
};
use serde_json::json;

#[test]
fn missing_weekly_known_zero_and_collection_error_are_three_distinct_answers() {
    let parsed = claude_statusline_usage(
        &json!({"rate_limits":{"five_hour":{"used_percentage":0}}}),
        100,
    )
    .unwrap();
    let five_hour = parsed
        .windows
        .iter()
        .find(|window| window.id == "five_hour")
        .unwrap();
    let weekly = parsed
        .windows
        .iter()
        .find(|window| window.id == "weekly")
        .unwrap();
    assert_eq!(five_hour.state, UsageState::Known);
    assert_eq!(five_hour.used_percent, Some(0.0));
    assert_eq!(weekly.state, UsageState::Absent);
    assert_eq!(weekly.used_percent, None);
    assert!(weekly.reason.as_deref().unwrap().contains("did not report"));
    assert!(weekly.display_text().contains("unknown"));
    assert!(!weekly.display_text().contains("0%"));
    let failure = UsageQuotaObservation::error("claude-statusline", 100, "read denied");
    assert_eq!(failure.state, UsageState::Error);
    assert_eq!(failure.windows[1].state, UsageState::Error);
    assert_eq!(failure.windows[1].used_percent, None);
    assert!(failure.display_lines()[1].contains("read denied"));
    assert_eq!(serde_json::to_value(&failure).unwrap()["state"], "error");
}

#[test]
fn codex_primary_weekly_is_classified_by_reported_duration() {
    let parsed = codex_rate_limit_usage(
        &json!({"limit_id":"codex", "primary":{
            "used_percent":10.0,"window_minutes":10080,"resets_at":1792888760
        },"secondary":null}),
        123,
    )
    .unwrap();
    assert_eq!(parsed.state, UsageState::Known);
    assert_eq!(parsed.windows.len(), 2);
    assert_eq!(parsed.windows[0].id, "five_hour");
    assert_eq!(parsed.windows[0].state, UsageState::Absent);
    assert_eq!(parsed.windows[0].used_percent, None);
    assert_eq!(parsed.windows[1].id, "weekly");
    assert_eq!(parsed.windows[1].used_percent, Some(10.0));
    assert_eq!(parsed.windows[1].window_minutes, Some(10080));
    assert_eq!(parsed.windows[1].resets_at, Some(1792888760));
    assert_eq!(parsed.observed_at, 123);
}

#[test]
fn claude_preserves_additional_windows_and_over_limit_percentage() {
    let parsed = claude_statusline_usage(
        &json!({"rate_limits":{
            "five_hour":{"used_percentage":2.5,"resets_at":200},
            "seven_day":{"used_percentage":40,"resets_at":300},
            "spend_limit":{"used_percentage":125.5,"resets_at":400,
                "used_usd":625,"limit_usd":500,"period":"monthly"},
            "seven_day_opus":{"used_percentage":80,"resets_at":500}
        }}),
        100,
    )
    .unwrap();
    assert_eq!(parsed.windows.len(), 4);
    let spend = parsed
        .windows
        .iter()
        .find(|window| window.id == "spend_limit")
        .unwrap();
    assert_eq!(spend.used_percent, Some(125.5));
    assert_eq!(spend.window_minutes, None);
    assert_eq!(spend.resets_at, Some(400));
    assert!(spend.display_text().contains("125.5%"));
    assert!(
        parsed
            .windows
            .iter()
            .any(|window| window.id == "seven_day_opus")
    );
}

#[test]
fn codex_preserves_extra_windows_and_named_metered_buckets() {
    let parsed = codex_rate_limit_usage(
        &json!({"limit_id":"codex_other","limit_name":"Special model",
            "primary":{"used_percent":20,"window_minutes":15},
            "secondary":{"used_percent":30,"window_minutes":300},
            "tertiary":{"used_percent":40,"window_minutes":60},
            "custom":{"used_percent":50,"window_minutes":120},
            "credits":{"has_credits":true,"unlimited":false,"balance":"10"}
        }),
        100,
    )
    .unwrap();
    assert_eq!(parsed.windows.len(), 6);
    assert!(parsed.windows.iter().any(|window| {
        window.id == "codex_other:primary"
            && window.label == "Special model 15m"
            && window.used_percent == Some(20.0)
    }));
    assert!(parsed.windows.iter().any(|window| {
        window.id == "codex_other:five_hour" && window.window_minutes == Some(300)
    }));
    assert!(
        parsed
            .windows
            .iter()
            .any(|window| window.id == "codex_other:custom")
    );
}

#[test]
fn malformed_runtime_payloads_are_errors_not_empty_observations() {
    for payload in [
        json!([]),
        json!({"rate_limits":false}),
        json!({"rate_limits":{"five_hour":"bad"}}),
        json!({"rate_limits":{"seven_day":{"used_percentage":"0"}}}),
        json!({"rate_limits":{"five_hour":{"used_percentage":-1}}}),
        json!({"rate_limits":{"five_hour":{"used_percentage":0,"resets_at":"soon"}}}),
    ] {
        assert!(claude_statusline_usage(&payload, 100).is_err(), "{payload}");
    }
    for payload in [
        json!([]),
        json!({"primary":false}),
        json!({"primary":{"used_percent":"0","window_minutes":300}}),
        json!({"primary":{"used_percent":0,"window_minutes":-1}}),
        json!({"primary":{"used_percent":0,"window_minutes":0}}),
        json!({"limit_id":7,"primary":{"used_percent":0}}),
    ] {
        assert!(codex_rate_limit_usage(&payload, 100).is_err(), "{payload}");
    }
}

#[test]
fn successful_runtime_absence_stays_absent_and_unknown() {
    for observation in [
        claude_statusline_usage(&json!({}), 100).unwrap(),
        claude_statusline_usage(&json!({"rate_limits":null}), 100).unwrap(),
        codex_rate_limit_usage(&json!(null), 100).unwrap(),
        codex_rate_limit_usage(&json!({"primary":null,"secondary":null}), 100).unwrap(),
    ] {
        assert_eq!(observation.state, UsageState::Absent);
        assert_eq!(observation.windows.len(), 2);
        assert!(
            observation
                .windows
                .iter()
                .all(|window| window.used_percent.is_none())
        );
        assert!(
            observation
                .display_lines()
                .iter()
                .all(|line| line.contains("unknown"))
        );
    }
}

#[test]
fn codex_unknown_window_duration_is_not_invented() {
    let parsed =
        codex_rate_limit_usage(&json!({"primary":{"used_percent":0,"resets_at":200}}), 100)
            .unwrap();
    assert_eq!(parsed.windows.len(), 3);
    let primary = parsed
        .windows
        .iter()
        .find(|window| window.id == "primary")
        .unwrap();
    assert_eq!(primary.used_percent, Some(0.0));
    assert_eq!(primary.window_minutes, None);
    assert_eq!(parsed.windows[0].state, UsageState::Absent);
    assert_eq!(parsed.windows[1].state, UsageState::Absent);
}

#[test]
fn codex_preserves_reported_spend_limit_without_inventing_a_window() {
    let parsed = codex_rate_limit_usage(
        &json!({"individual_limit":{
            "remaining_percent":25,"used":"375","limit":"500","resets_at":200
        }}),
        100,
    )
    .unwrap();
    let spend = parsed
        .windows
        .iter()
        .find(|window| window.id == "individual_limit")
        .unwrap();
    assert_eq!(spend.state, UsageState::Known);
    assert_eq!(spend.used_percent, Some(75.0));
    assert_eq!(spend.window_minutes, None);
    assert_eq!(spend.resets_at, Some(200));
    assert!(codex_rate_limit_usage(&json!({"individual_limit":[]}), 100).is_err());
    assert!(
        codex_rate_limit_usage(&json!({"individual_limit":{"remaining_percent":"25"}}), 100)
            .is_err()
    );
}

#[test]
fn claude_reports_raw_spend_with_only_runtime_supplied_ceiling_and_percentage() {
    for (limits, expected, percent, ceiling) in [
        (
            json!({"used_usd":314.12,"period":"monthly"}),
            "$314.12 used, monthly",
            None,
            None,
        ),
        (
            json!({"used_usd":314.12,"limit_usd":500,"period":"monthly"}),
            "$314.12 / $500, monthly",
            None,
            Some(500.0),
        ),
        (
            json!({"used_usd":314.12,"limit_usd":500,"used_percentage":62.8}),
            "$314.12 / $500 (62.8% used)",
            Some(62.8),
            Some(500.0),
        ),
    ] {
        let parsed =
            claude_statusline_usage(&json!({"rate_limits":{"spend_limit":limits}}), 100).unwrap();
        let spend = parsed
            .windows
            .iter()
            .find(|window| window.id == "spend_limit")
            .unwrap();
        assert_eq!(spend.state, UsageState::Known);
        assert_eq!(spend.used_usd, Some(314.12));
        assert_eq!(spend.limit_usd, ceiling);
        assert_eq!(spend.used_percent, percent);
        assert!(
            spend.display_text().ends_with(expected),
            "{}",
            spend.display_text()
        );
    }
    for malformed in [
        json!({"used_usd":"314.12"}),
        json!({"used_usd":-1}),
        json!({"used_usd":0,"limit_usd":"500"}),
        json!({"used_usd":0,"period":1}),
    ] {
        assert!(
            claude_statusline_usage(&json!({"rate_limits":{"spend_limit":malformed}}), 100)
                .is_err()
        );
    }
}
