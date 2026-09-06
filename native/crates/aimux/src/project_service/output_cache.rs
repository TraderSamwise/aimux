use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::tmux::CapturePaneOptions;

pub const AGENT_OUTPUT_CAPTURE_CACHE_TTL_MS: u64 = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentOutputCaptureCacheKey {
    pub window_id: String,
    pub options: CapturePaneOptions,
}

#[derive(Debug, Clone)]
pub struct AgentOutputCaptureCache {
    inner: Arc<Mutex<Option<AgentOutputCaptureCacheEntry>>>,
    ttl: Duration,
}

#[derive(Debug, Clone)]
struct AgentOutputCaptureCacheEntry {
    key: AgentOutputCaptureCacheKey,
    output: String,
    captured_at: Instant,
}

impl Default for AgentOutputCaptureCache {
    fn default() -> Self {
        Self::new(Duration::from_millis(AGENT_OUTPUT_CAPTURE_CACHE_TTL_MS))
    }
}

impl AgentOutputCaptureCache {
    pub fn new(ttl: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            ttl,
        }
    }

    pub fn capture_or_reuse<F>(
        &self,
        key: AgentOutputCaptureCacheKey,
        capture: F,
    ) -> Result<String, String>
    where
        F: FnOnce() -> Result<String, String>,
    {
        let mut cached = self.inner.lock().map_err(|error| error.to_string())?;
        if let Some(entry) = cached.as_ref()
            && entry.key == key
            && entry.captured_at.elapsed() <= self.ttl
        {
            return Ok(entry.output.clone());
        }
        let output = capture()?;
        *cached = Some(AgentOutputCaptureCacheEntry {
            key,
            output: output.clone(),
            captured_at: Instant::now(),
        });
        Ok(output)
    }
}
