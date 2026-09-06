use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

static LIFECYCLE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(super) fn pseudo_uuid_v4() -> String {
    let digest = sha256_hex(&format!(
        "{}:{}:{}",
        time::OffsetDateTime::now_utc().unix_timestamp_nanos(),
        std::process::id(),
        LIFECYCLE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    format!(
        "{}-{}-4{}-a{}-{}",
        &digest[0..8],
        &digest[8..12],
        &digest[13..16],
        &digest[17..20],
        &digest[20..32]
    )
}

pub(super) fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn short_id() -> String {
    base36_sequence().chars().rev().take(8).collect()
}

pub(super) fn random_id(prefix: &str) -> String {
    format!("{prefix}-{}", base36_sequence())
}

pub(super) fn base36_sequence() -> String {
    let value = (time::OffsetDateTime::now_utc().unix_timestamp_nanos() as u128)
        ^ (u128::from(std::process::id()) << 32)
        ^ u128::from(LIFECYCLE_SEQUENCE.fetch_add(1, Ordering::Relaxed));
    base36(value)
}

fn base36(mut value: u128) -> String {
    if value == 0 {
        return "0".into();
    }
    let mut digits = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        digits.push(match digit {
            0..=9 => (b'0' + digit) as char,
            _ => (b'a' + digit - 10) as char,
        });
        value /= 36;
    }
    digits.into_iter().rev().collect()
}

pub(super) fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}
