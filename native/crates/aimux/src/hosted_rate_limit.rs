use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HostedRateLimitOptions {
    pub requests_per_minute: f64,
    pub max_concurrent: i64,
    pub bytes_per_minute: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedLimitDenied {
    pub ok: bool,
    pub reason: String,
}

#[derive(Debug)]
pub enum HostedLimitOutcome {
    Allowed(HostedRateLimitRelease),
    Denied(HostedLimitDenied),
}

impl HostedLimitOutcome {
    pub fn ok_without_release(&self) -> bool {
        matches!(self, Self::Allowed(_))
    }

    pub fn reason(&self) -> Option<&str> {
        match self {
            Self::Allowed(_) => None,
            Self::Denied(denied) => Some(&denied.reason),
        }
    }
}

#[derive(Clone)]
pub struct HostedRateLimiter {
    inner: Arc<Mutex<HostedRateLimiterState>>,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
}

#[derive(Debug)]
pub struct HostedRateLimitRelease {
    inner: Arc<Mutex<HostedRateLimiterState>>,
    key: String,
    released: AtomicBool,
}

#[derive(Debug, Clone)]
struct HostedRateLimiterState {
    options: HostedRateLimitOptions,
    buckets: BTreeMap<String, Bucket>,
}

#[derive(Debug, Clone)]
struct Bucket {
    tokens: f64,
    byte_tokens: f64,
    updated_at: f64,
    in_flight: i64,
}

impl HostedRateLimiter {
    pub fn new(options: HostedRateLimitOptions) -> Self {
        Self::with_now(options, || unix_millis(SystemTime::now()) as f64)
    }

    pub fn with_now(
        options: HostedRateLimitOptions,
        now: impl Fn() -> f64 + Send + Sync + 'static,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HostedRateLimiterState {
                options,
                buckets: BTreeMap::new(),
            })),
            now: Arc::new(now),
        }
    }

    pub fn acquire(&self, key: &str) -> HostedLimitOutcome {
        let now = (self.now)();
        let mut state = self.inner.lock().expect("hosted rate limiter mutex");
        let options = state.options;
        let bucket = state.bucket_for(key, now);
        refill_bucket(bucket, options, now);
        if bucket.in_flight >= options.max_concurrent {
            return HostedLimitOutcome::Denied(HostedLimitDenied {
                ok: false,
                reason: "concurrency".to_owned(),
            });
        }
        if bucket.tokens < 1.0 {
            return HostedLimitOutcome::Denied(HostedLimitDenied {
                ok: false,
                reason: "rate".to_owned(),
            });
        }
        bucket.tokens -= 1.0;
        bucket.in_flight += 1;
        HostedLimitOutcome::Allowed(HostedRateLimitRelease {
            inner: Arc::clone(&self.inner),
            key: key.to_owned(),
            released: AtomicBool::new(false),
        })
    }

    pub fn charge(&self, key: &str, bytes: f64) -> bool {
        if bytes <= 0.0 {
            return true;
        }
        let now = (self.now)();
        let mut state = self.inner.lock().expect("hosted rate limiter mutex");
        let options = state.options;
        let bucket = state.bucket_for(key, now);
        refill_bucket(bucket, options, now);
        if bucket.byte_tokens < bytes {
            bucket.byte_tokens = 0.0;
            return false;
        }
        bucket.byte_tokens -= bytes;
        true
    }

    pub fn prune(&self, idle_ms: f64) {
        let now = (self.now)();
        let mut state = self.inner.lock().expect("hosted rate limiter mutex");
        state
            .buckets
            .retain(|_, bucket| bucket.in_flight != 0 || now - bucket.updated_at <= idle_ms);
    }
}

impl HostedRateLimitRelease {
    pub fn release(&self) {
        if self.released.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut state) = self.inner.lock()
            && let Some(bucket) = state.buckets.get_mut(&self.key)
        {
            bucket.in_flight = 0.max(bucket.in_flight - 1);
        }
    }
}

impl HostedRateLimiterState {
    fn bucket_for(&mut self, key: &str, now: f64) -> &mut Bucket {
        self.buckets.entry(key.to_owned()).or_insert(Bucket {
            tokens: self.options.requests_per_minute,
            byte_tokens: self.options.bytes_per_minute,
            updated_at: now,
            in_flight: 0,
        })
    }
}

fn refill_bucket(bucket: &mut Bucket, options: HostedRateLimitOptions, now: f64) {
    let elapsed = (now - bucket.updated_at).max(0.0);
    let share = elapsed / 60_000.0;
    bucket.tokens = options
        .requests_per_minute
        .min(bucket.tokens + share * options.requests_per_minute);
    bucket.byte_tokens = options
        .bytes_per_minute
        .min(bucket.byte_tokens + share * options.bytes_per_minute);
    bucket.updated_at = now;
}

fn unix_millis(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
