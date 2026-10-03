//! Proves the daemon still answers, and ends it when it stops.
//!
//! Twice now the daemon has held its listener while every runtime thread sat
//! parked: the kernel completed the TCP handshake into the backlog, so a client
//! connected, sent its request and waited forever. `aimux daemon status` kept
//! working — it reads state off disk — so the fleet looked healthy while every
//! route hung.
//!
//! The probe runs on its own OS thread, not on the async runtime, because a
//! watchdog scheduled on the runtime it is watching stalls with it. When the
//! daemon stops answering its own health route the process exits, and the next
//! CLI call starts a fresh one instead of hanging against the old one.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::time::Duration;

/// Slow: this is a liveness check, not a metric. A wedged daemon has already
/// stopped answering, and a minute of hanging is not meaningfully worse than
/// thirty seconds of it.
pub const PROBE_INTERVAL: Duration = Duration::from_secs(30);
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// One failure is a busy moment. Three in a row, each ten seconds apart, is a
/// daemon that is not coming back.
pub const FAILURES_BEFORE_EXIT: u32 = 3;
/// Distinct from any route's exit code so the restart is identifiable in logs.
pub const WEDGED_EXIT_CODE: i32 = 70;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchdogAction {
    /// Nothing to do: still answering, or not yet proven to have ever answered.
    Wait,
    /// Answering again after a failure; the counter resets.
    Recovered,
    /// Stopped answering for long enough. End the process.
    ExitWedged,
}

/// The whole decision, with no socket in it.
///
/// `armed` is false until the daemon has answered once, so a slow start is
/// never mistaken for a wedge. `shutting_down` suppresses the exit because a
/// daemon that is on its way out has a reason not to answer.
pub fn watchdog_action(
    probe_succeeded: bool,
    consecutive_failures: u32,
    armed: bool,
    shutting_down: bool,
) -> WatchdogAction {
    if probe_succeeded {
        return if consecutive_failures > 0 {
            WatchdogAction::Recovered
        } else {
            WatchdogAction::Wait
        };
    }
    if !armed || shutting_down {
        return WatchdogAction::Wait;
    }
    if consecutive_failures >= FAILURES_BEFORE_EXIT {
        WatchdogAction::ExitWedged
    } else {
        WatchdogAction::Wait
    }
}

/// One blocking health request. `Err` carries what went wrong, so a watchdog
/// exit can say which half failed rather than only that it gave up.
pub fn probe_health(host: &str, port: u16) -> Result<(), String> {
    let address = format!("{host}:{port}");
    let target: std::net::SocketAddr = address
        .parse()
        .map_err(|error| format!("bad probe address {address}: {error}"))?;
    // The daemon only ever listens on loopback, and this probe must never
    // become a way to reach anything else.
    if !target.ip().is_loopback() {
        return Err(format!(
            "refusing to probe a non-loopback address: {address}"
        ));
    }
    let mut stream = TcpStream::connect_timeout(&target, PROBE_TIMEOUT)
        .map_err(|error| format!("connect failed: {error}"))?;
    stream
        .set_read_timeout(Some(PROBE_TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(PROBE_TIMEOUT)))
        .map_err(|error| format!("setting probe timeouts failed: {error}"))?;
    stream
        .write_all(
            format!("GET /health HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes(),
        )
        .map_err(|error| format!("writing the probe request failed: {error}"))?;
    stream
        .flush()
        .map_err(|error| format!("flushing the probe request failed: {error}"))?;
    let mut response = Vec::new();
    // The wedge shape is a connection that accepts and then never answers, so
    // the read timeout is the thing that actually catches it.
    let read = (&mut stream)
        .take(512)
        .read_to_end(&mut response)
        .map_err(|error| format!("no response: {error}"))?;
    let _ = stream.shutdown(Shutdown::Both);
    if read == 0 {
        return Err("the daemon accepted the connection and answered nothing".to_owned());
    }
    let head = String::from_utf8_lossy(&response);
    if head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200") {
        Ok(())
    } else {
        Err(format!(
            "health answered {}",
            head.lines().next().unwrap_or("nothing readable")
        ))
    }
}

/// Start the probe on its own OS thread. Returns immediately; the thread ends
/// the process if the daemon stops answering.
pub fn spawn_daemon_watchdog(host: String, port: u16) {
    let _ = std::thread::Builder::new()
        .name("aimux-daemon-watchdog".to_owned())
        .spawn(move || run_watchdog_loop(&host, port));
}

fn run_watchdog_loop(host: &str, port: u16) -> ! {
    let mut consecutive_failures = 0u32;
    let mut armed = false;
    let mut last_error = String::new();
    loop {
        std::thread::sleep(PROBE_INTERVAL);
        let shutting_down = crate::process_signals::received_shutdown_signal().is_some();
        let outcome = probe_health(host, port);
        if let Err(error) = &outcome {
            last_error = error.clone();
        }
        let action = watchdog_action(
            outcome.is_ok(),
            consecutive_failures + u32::from(outcome.is_err()),
            armed,
            shutting_down,
        );
        match action {
            WatchdogAction::Wait => {
                if outcome.is_ok() {
                    armed = true;
                    consecutive_failures = 0;
                } else {
                    consecutive_failures += 1;
                }
            }
            WatchdogAction::Recovered => {
                crate::debug_logging::log_lifecycle_always(
                    "daemon health recovered",
                    "daemon-watchdog",
                    Some(serde_json::json!({
                        "consecutiveFailures": consecutive_failures,
                        "lastError": last_error,
                    })),
                );
                armed = true;
                consecutive_failures = 0;
            }
            WatchdogAction::ExitWedged => {
                let detail = serde_json::json!({
                    "port": port,
                    "consecutiveFailures": consecutive_failures + 1,
                    "lastError": last_error,
                    "exitCode": WEDGED_EXIT_CODE,
                });
                crate::debug_logging::log_lifecycle_always(
                    "daemon wedged, exiting so the next command can start a live one",
                    "daemon-watchdog",
                    Some(detail.clone()),
                );
                eprintln!("aimux daemon wedged and is exiting: {detail}");
                std::process::exit(WEDGED_EXIT_CODE);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slow_start_is_not_a_wedge() {
        for failures in 0..=FAILURES_BEFORE_EXIT + 2 {
            assert_eq!(
                watchdog_action(false, failures, false, false),
                WatchdogAction::Wait,
                "a daemon that has never answered yet is still starting"
            );
        }
    }

    #[test]
    fn a_daemon_on_its_way_out_is_not_killed_for_not_answering() {
        assert_eq!(
            watchdog_action(false, FAILURES_BEFORE_EXIT + 5, true, true),
            WatchdogAction::Wait
        );
    }

    #[test]
    fn one_bad_probe_is_not_enough() {
        assert_eq!(
            watchdog_action(false, 1, true, false),
            WatchdogAction::Wait,
            "a single miss is a busy moment, not a wedge"
        );
        assert_eq!(watchdog_action(false, 2, true, false), WatchdogAction::Wait);
    }

    #[test]
    fn a_daemon_that_stopped_answering_is_ended() {
        assert_eq!(
            watchdog_action(false, FAILURES_BEFORE_EXIT, true, false),
            WatchdogAction::ExitWedged
        );
    }

    #[test]
    fn answering_again_clears_the_count() {
        assert_eq!(
            watchdog_action(true, 2, true, false),
            WatchdogAction::Recovered
        );
        assert_eq!(watchdog_action(true, 0, true, false), WatchdogAction::Wait);
    }

    #[test]
    fn a_probe_refuses_an_address_that_is_not_loopback() {
        let error = probe_health("93.184.216.34", 80).expect_err("not loopback");
        assert!(error.contains("non-loopback"), "{error}");
    }

    #[test]
    fn a_probe_against_nothing_reports_why() {
        // Port 1 on loopback refuses rather than hanging, which is the error
        // path the exit message has to be able to name.
        let error = probe_health("127.0.0.1", 1).expect_err("nothing listens on port 1");
        assert!(error.contains("connect failed"), "{error}");
    }
}
