use aimux::tmux_startup_interstitials::{
    StartupInterstitial, StartupInterstitialDismisser, find_startup_interstitial,
    resolve_interstitial_key,
};
use serde_json::{Value, json};

const TMUX_STARTUP_INTERSTITIALS: &str =
    include_str!("../../../../testdata/contracts/v1/tmux/startup-interstitials.json");

const REAL_UPDATE_SCREEN: &str = "  ✨ Update available! 0.146.0 -> 0.146.1\n\n  Release notes: https://github.com/openai/codex/releases/latest\n\n› 1. Update now (runs `npm install -g @openai/codex`)\n  2. Skip\n  3. Skip until next version\n\n  Press enter to continue";
const REAL_TRUST_SCREEN: &str = "> You are in /tmp\n\n  Do you trust the contents of this directory?\n\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue";

#[test]
fn fixture_tmux_startup_interstitials_matches_typescript_contract() {
    let contract: Value = serde_json::from_str(TMUX_STARTUP_INTERSTITIALS)
        .expect("valid startup interstitials fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("startup interstitial cases");
    assert_eq!(cases.len(), 8, "unexpected startup interstitial case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = run_case(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} tmux-startup-interstitials parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    match case["name"].as_str().expect("case name") {
        "chooses Skip on the real codex update screen" => {
            json!({ "key": resolve_interstitial_key(REAL_UPDATE_SCREEN, &codex_update()) })
        }
        "prefers plain Skip over Skip until next version" => json!({
            "key": resolve_interstitial_key(
                &REAL_UPDATE_SCREEN.replace(
                    "  2. Skip\n  3. Skip until next version",
                    "  2. Skip until next version\n  3. Skip",
                ),
                &codex_update(),
            )
        }),
        "reads the number off the menu" => json!({
            "key": resolve_interstitial_key(
                &REAL_UPDATE_SCREEN.replace("  2. Skip", "  7. Skip"),
                &codex_update(),
            )
        }),
        "finds Skip when selected" => json!({
            "key": resolve_interstitial_key(
                &REAL_UPDATE_SCREEN
                    .replace("› 1. Update now", "  1. Update now")
                    .replace("  2. Skip", "› 2. Skip"),
                &codex_update(),
            )
        }),
        "returns null when not showing or option missing" => json!({
            "trust": resolve_interstitial_key(REAL_TRUST_SCREEN, &codex_update()),
            "empty": resolve_interstitial_key("", &codex_update()),
            "withoutSkip": resolve_interstitial_key(
                &REAL_UPDATE_SCREEN
                    .replace("  2. Skip\n", "")
                    .replace("  3. Skip until next version", "  2. Remind me later"),
                &codex_update(),
            ),
            "chatter": resolve_interstitial_key(
                "› Ask codex whether an Update available! banner needs a Press enter to continue guard.",
                &codex_update(),
            ),
        }),
        "findStartupInterstitial returns matching interstitial and skips earlier misses" => json!({
            "direct": interstitial_match_to_value(find_startup_interstitial(REAL_UPDATE_SCREEN, &[codex_update()])),
            "none": interstitial_match_to_value(find_startup_interstitial(REAL_TRUST_SCREEN, &[codex_update()])),
            "later": interstitial_match_to_value(find_startup_interstitial(
                REAL_UPDATE_SCREEN,
                &[
                    StartupInterstitial {
                        id: "never".into(),
                        when: vec!["nothing like this".into()],
                        choose: "^(\\d+)$".into(),
                    },
                    codex_update(),
                ],
            )),
        }),
        "dismisser answers each prompt once" => {
            let mut dismisser =
                StartupInterstitialDismisser::new(vec![codex_update(), trust_interstitial()]);
            json!({
                "first": interstitial_match_to_value(dismisser.next(REAL_UPDATE_SCREEN)),
                "lingering": interstitial_match_to_value(dismisser.next(REAL_UPDATE_SCREEN)),
                "second": interstitial_match_to_value(dismisser.next(REAL_TRUST_SCREEN)),
                "repeatedSecond": interstitial_match_to_value(dismisser.next(REAL_TRUST_SCREEN)),
                "done": dismisser.done(),
            })
        }
        "dismisser ignores ordinary sessions without completing" => {
            let mut dismisser =
                StartupInterstitialDismisser::new(vec![codex_update(), trust_interstitial()]);
            json!({
                "next": interstitial_match_to_value(
                    dismisser.next("› ready\n\n  gpt-5.6-sol default · /srv/grand-console")
                ),
                "done": dismisser.done(),
            })
        }
        unexpected => panic!("unexpected case {unexpected}"),
    }
}

fn codex_update() -> StartupInterstitial {
    StartupInterstitial {
        id: "codex-update-available".into(),
        when: vec!["Update available!".into(), "Press enter to continue".into()],
        choose: "^[\\s›>❯]*(\\d+)\\.\\s+Skip\\s*$".into(),
    }
}

fn trust_interstitial() -> StartupInterstitial {
    StartupInterstitial {
        id: "codex-trust-directory".into(),
        when: vec!["Do you trust the contents of this directory?".into()],
        choose: "^[\\s›>❯]*(\\d+)\\.\\s+Yes, continue\\s*$".into(),
    }
}

fn interstitial_match_to_value(
    found: Option<aimux::tmux_startup_interstitials::StartupInterstitialMatch>,
) -> Value {
    found.map_or(Value::Null, |found| {
        json!({
            "interstitial": interstitial_to_value(&found.interstitial),
            "key": found.key,
        })
    })
}

fn interstitial_to_value(interstitial: &StartupInterstitial) -> Value {
    json!({
        "id": interstitial.id,
        "when": interstitial.when,
        "choose": interstitial.choose,
    })
}
