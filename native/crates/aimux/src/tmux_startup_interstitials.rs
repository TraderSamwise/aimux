use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupInterstitial {
    pub id: String,
    pub when: Vec<String>,
    pub choose: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupInterstitialMatch {
    pub interstitial: StartupInterstitial,
    pub key: String,
}

pub fn resolve_interstitial_key(
    screen: &str,
    interstitial: &StartupInterstitial,
) -> Option<String> {
    if !interstitial
        .when
        .iter()
        .all(|fragment| screen.contains(fragment))
    {
        return None;
    }
    resolve_supported_choice(screen, &interstitial.choose)
}

pub fn find_startup_interstitial(
    screen: &str,
    interstitials: &[StartupInterstitial],
) -> Option<StartupInterstitialMatch> {
    for interstitial in interstitials {
        if let Some(key) = resolve_interstitial_key(screen, interstitial) {
            return Some(StartupInterstitialMatch {
                interstitial: interstitial.clone(),
                key,
            });
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct StartupInterstitialDismisser {
    interstitials: Vec<StartupInterstitial>,
    answered: BTreeSet<String>,
}

impl StartupInterstitialDismisser {
    pub fn new(interstitials: Vec<StartupInterstitial>) -> Self {
        Self {
            interstitials,
            answered: BTreeSet::new(),
        }
    }

    pub fn next(&mut self, screen: &str) -> Option<StartupInterstitialMatch> {
        let pending = self
            .interstitials
            .iter()
            .filter(|interstitial| !self.answered.contains(&interstitial.id))
            .cloned()
            .collect::<Vec<_>>();
        let found = find_startup_interstitial(screen, &pending)?;
        self.answered.insert(found.interstitial.id.clone());
        Some(found)
    }

    pub fn done(&self) -> bool {
        self.answered.len() >= self.interstitials.len()
    }
}

fn resolve_supported_choice(screen: &str, pattern: &str) -> Option<String> {
    if let Some(suffix) = pattern.strip_prefix("^[\\s›>❯]*(\\d+)\\.\\s+") {
        let label = suffix.strip_suffix("\\s*$")?;
        let label = label.replace("\\s+", " ");
        for line in screen.lines() {
            let trimmed = line
                .trim_start_matches(|ch: char| ch.is_whitespace() || matches!(ch, '›' | '>' | '❯'));
            let Some((number, rest)) = trimmed.split_once('.') else {
                continue;
            };
            if number.is_empty() || !number.chars().all(|ch| ch.is_ascii_digit()) {
                continue;
            }
            if rest.trim() == label {
                return Some(number.to_owned());
            }
        }
    }
    None
}
