//! Whether this machine can take another agent right now.
//!
//! On 2026-10-03 a restore put 35 agents back on sam-strix in 13 seconds. Each
//! one resumed its task, every task runs test suites, and the box went from
//! idle to 61 of 62GB used with all 8GB of swap consumed. The kernel killed the
//! tmux server, aimux rebuilt the runtime and relaunched the agents into a
//! machine that had just run out of memory, and it left the network for twenty
//! minutes.
//!
//! Launching is not free, and nothing in the launch path knew that.

use std::time::Duration;

/// Enough for one agent and the test run it is about to start. Below this a
/// launch is not "a bit slow", it is the next OOM kill.
pub const DEFAULT_MEMORY_FLOOR_BYTES: u64 = 3 * 1024 * 1024 * 1024;

/// Launching a fleet one process at a time, with a breath between each, so the
/// memory a launch costs shows up in the next reading.
pub const LAUNCH_SPACING: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchCapacity {
    /// Go ahead. Either there is room, or this host cannot be measured and a
    /// refusal would be a guess.
    Room,
    /// Stop. Carries what was seen, so the refusal can say it.
    OutOfMemory {
        available_bytes: u64,
        floor_bytes: u64,
    },
}

impl LaunchCapacity {
    pub fn message(&self) -> Option<String> {
        match self {
            Self::Room => None,
            Self::OutOfMemory {
                available_bytes,
                floor_bytes,
            } => Some(format!(
                "stopped: {} of memory available, below the {} a new agent needs",
                human_bytes(*available_bytes),
                human_bytes(*floor_bytes)
            )),
        }
    }
}

/// The decision, with no machine in it.
///
/// `available` is `None` when the host could not be measured; that is not
/// evidence of a full machine, so it reads as room rather than a refusal.
pub fn launch_capacity(available: Option<u64>, floor_bytes: u64) -> LaunchCapacity {
    match available {
        Some(available_bytes) if available_bytes < floor_bytes => LaunchCapacity::OutOfMemory {
            available_bytes,
            floor_bytes,
        },
        _ => LaunchCapacity::Room,
    }
}

/// Memory the kernel says is available for a new process without swapping.
/// `None` where that cannot be read, which includes every non-Linux host.
pub fn available_memory_bytes() -> Option<u64> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    parse_available_memory(&meminfo)
}

/// `MemAvailable` is the kernel's own estimate and already accounts for
/// reclaimable cache, which `MemFree` does not.
pub fn parse_available_memory(meminfo: &str) -> Option<u64> {
    meminfo
        .lines()
        .find_map(|line| line.strip_prefix("MemAvailable:"))
        .and_then(|value| value.split_whitespace().next())
        .and_then(|kilobytes| kilobytes.parse::<u64>().ok())
        .map(|kilobytes| kilobytes * 1024)
}

pub fn memory_floor_bytes() -> u64 {
    std::env::var("AIMUX_LAUNCH_MEMORY_FLOOR_BYTES")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_MEMORY_FLOOR_BYTES)
}

fn human_bytes(bytes: u64) -> String {
    let gigabytes = bytes as f64 / (1024.0 * 1024.0 * 1024.0);
    if gigabytes >= 1.0 {
        format!("{gigabytes:.1}GB")
    } else {
        format!("{}MB", bytes / (1024 * 1024))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MEMINFO: &str = "MemTotal:       64174404 kB\nMemFree:          607372 kB\nMemAvailable:    1149952 kB\nBuffers:          12345 kB\n";

    #[test]
    fn reads_the_kernels_own_estimate_not_free_memory() {
        assert_eq!(parse_available_memory(MEMINFO), Some(1_149_952 * 1024));
    }

    #[test]
    fn a_host_that_cannot_be_measured_is_not_a_full_host() {
        assert_eq!(parse_available_memory("nothing useful"), None);
        assert_eq!(
            launch_capacity(None, DEFAULT_MEMORY_FLOOR_BYTES),
            LaunchCapacity::Room,
            "refusing on an unreadable host would block every mac"
        );
    }

    // The reading taken on sam-strix minutes before it left the network.
    #[test]
    fn the_machine_that_fell_over_would_have_been_refused() {
        let available = parse_available_memory(MEMINFO).expect("available");
        let capacity = launch_capacity(Some(available), DEFAULT_MEMORY_FLOOR_BYTES);
        assert_eq!(
            capacity,
            LaunchCapacity::OutOfMemory {
                available_bytes: available,
                floor_bytes: DEFAULT_MEMORY_FLOOR_BYTES
            }
        );
        let message = capacity.message().expect("a reason");
        assert!(message.contains("1.1GB"), "{message}");
        assert!(message.contains("3.0GB"), "{message}");
    }

    #[test]
    fn an_idle_machine_has_room() {
        let idle = 61 * 1024 * 1024 * 1024;
        assert_eq!(
            launch_capacity(Some(idle), DEFAULT_MEMORY_FLOOR_BYTES),
            LaunchCapacity::Room
        );
        assert_eq!(
            launch_capacity(Some(DEFAULT_MEMORY_FLOOR_BYTES), DEFAULT_MEMORY_FLOOR_BYTES),
            LaunchCapacity::Room
        );
    }

    #[test]
    fn the_floor_can_be_set_for_a_machine_that_knows_better() {
        // SAFETY: single-threaded test process.
        unsafe { std::env::set_var("AIMUX_LAUNCH_MEMORY_FLOOR_BYTES", "7340032") };
        assert_eq!(memory_floor_bytes(), 7_340_032);
        unsafe { std::env::remove_var("AIMUX_LAUNCH_MEMORY_FLOOR_BYTES") };
        assert_eq!(memory_floor_bytes(), DEFAULT_MEMORY_FLOOR_BYTES);
    }
}
