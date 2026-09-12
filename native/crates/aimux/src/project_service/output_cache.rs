use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::tmux::CapturePaneOptions;

pub const AGENT_OUTPUT_CAPTURE_CACHE_TTL_MS: u64 = 450;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct AgentOutputCaptureCacheKey {
    pub window_id: String,
    pub options: CapturePaneOptions,
}

#[derive(Debug, Clone)]
pub struct AgentOutputCaptureCache {
    inner: Arc<Mutex<BTreeMap<AgentOutputCaptureCacheKey, AgentOutputCaptureCacheEntry>>>,
    ttl: Duration,
}

#[derive(Debug, Clone)]
struct AgentOutputCaptureCacheEntry {
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
            inner: Arc::new(Mutex::new(BTreeMap::new())),
            ttl,
        }
    }

    pub fn capture_or_reuse<F>(
        &self,
        key: AgentOutputCaptureCacheKey,
        capture: F,
    ) -> Result<(String, bool), String>
    where
        F: FnOnce() -> Result<String, String>,
    {
        let mut cached = self.inner.lock().map_err(|error| error.to_string())?;
        cached.retain(|_, entry| entry.captured_at.elapsed() <= self.ttl);
        if let Some(entry) = cached.get(&key) {
            return Ok((entry.output.clone(), true));
        }
        let output = capture()?;
        cached.insert(
            key,
            AgentOutputCaptureCacheEntry {
                output: output.clone(),
                captured_at: Instant::now(),
            },
        );
        Ok((output, false))
    }

    pub fn fresh(&self, key: &AgentOutputCaptureCacheKey) -> Result<Option<String>, String> {
        let mut cached = self.inner.lock().map_err(|error| error.to_string())?;
        cached.retain(|_, entry| entry.captured_at.elapsed() <= self.ttl);
        Ok(cached.get(key).map(|entry| entry.output.clone()))
    }

    pub fn store(&self, key: AgentOutputCaptureCacheKey, output: String) -> Result<(), String> {
        let mut cached = self.inner.lock().map_err(|error| error.to_string())?;
        cached.insert(
            key,
            AgentOutputCaptureCacheEntry {
                output,
                captured_at: Instant::now(),
            },
        );
        Ok(())
    }
}
