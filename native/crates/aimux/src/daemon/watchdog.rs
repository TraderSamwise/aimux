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
    watchdog_action_within(
        probe_succeeded,
        consecutive_failures,
        armed,
        shutting_down,
        FAILURES_BEFORE_EXIT,
    )
}

/// The same decision against a named budget, so a process kind that needs more
/// patience than the daemon gets it without a second copy of the rule.
pub fn watchdog_action_within(
    probe_succeeded: bool,
    consecutive_failures: u32,
    armed: bool,
    shutting_down: bool,
    failures_before_exit: u32,
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
    if consecutive_failures >= failures_before_exit {
        WatchdogAction::ExitWedged
    } else {
        WatchdogAction::Wait
    }
}

/// One blocking health request. `Err` carries what went wrong, so a watchdog
/// exit can say which half failed rather than only that it gave up.
pub fn probe_health(host: &str, port: u16) -> Result<(), String> {
    probe_health_within(host, port, PROBE_TIMEOUT)
}

pub fn probe_health_within(host: &str, port: u16, timeout: Duration) -> Result<(), String> {
    let address = format!("{host}:{port}");
    let target: std::net::SocketAddr = address
        .parse()
        .map_err(|error| format!("bad probe address {address}: {error}"))?;
    // Every process this probes listens on loopback only, and the probe must
    // never become a way to reach anything else.
    if !target.ip().is_loopback() {
        return Err(format!(
            "refusing to probe a non-loopback address: {address}"
        ));
    }
    let mut stream = TcpStream::connect_timeout(&target, timeout)
        .map_err(|error| format!("connect failed: {error}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .and_then(|()| stream.set_write_timeout(Some(timeout)))
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
        return Err("the connection was accepted and nothing was answered".to_owned());
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

/// How long a process gets to keep failing before it ends itself.
///
/// A budget per process kind, not one shared constant: the daemon serves state
/// off disk, while a project service's `/health` builds scheduler diagnostics
/// on a two-worker runtime, so its latency tracks contention. The thing a
/// watchdog must never do is end a service that is merely starved of CPU.
#[derive(Debug, Clone, Copy)]
pub struct WatchdogBudget {
    pub label: &'static str,
    pub interval: Duration,
    pub timeout: Duration,
    pub failures_before_exit: u32,
}

pub const DAEMON_WATCHDOG: WatchdogBudget = WatchdogBudget {
    label: "daemon",
    interval: PROBE_INTERVAL,
    timeout: PROBE_TIMEOUT,
    failures_before_exit: FAILURES_BEFORE_EXIT,
};

/// Deliberately more patient than the daemon's.
///
/// A project service answers `/health` by building scheduler diagnostics on a
/// two-worker runtime, so its latency tracks contention -- and this machine
/// routinely has ten agents compiling. Five strikes a minute apart is five
/// minutes of continuous silence before the service ends itself, which a
/// service that is merely starved of CPU does not reach, while the wedge this
/// exists for lasted 4 days 19 hours. Ending a healthy service under load
/// would be worse than the wedge.
pub const PROJECT_SERVICE_WATCHDOG: WatchdogBudget = WatchdogBudget {
    label: "project-service",
    interval: Duration::from_secs(60),
    timeout: Duration::from_secs(15),
    failures_before_exit: 5,
};

/// Start the probe on its own OS thread. Returns immediately; the thread ends
/// the process if it stops answering its own health route.
///
/// Its own OS thread, not a task on the async runtime, because a watchdog
/// scheduled on the runtime it is watching stalls with it.
pub fn spawn_health_watchdog(budget: WatchdogBudget, host: String, port: u16) {
    let thread_name = format!("aimux-{}-watchdog", budget.label);
    // Logged so a live process can be asked whether it armed this at all. A
    // defence nobody spawned is the shape of the incident behind it: the
    // daemon had this watchdog all along and the project service armed none.
    crate::debug_logging::log_lifecycle_always(
        "health watchdog armed",
        budget.label,
        Some(serde_json::json!({
            "port": port,
            "intervalMs": budget.interval.as_millis(),
            "timeoutMs": budget.timeout.as_millis(),
            "failuresBeforeExit": budget.failures_before_exit,
        })),
    );
    let _ = std::thread::Builder::new()
        .name(thread_name)
        .spawn(move || run_watchdog_loop(budget, &host, port));
}

pub fn spawn_daemon_watchdog(host: String, port: u16) {
    spawn_health_watchdog(DAEMON_WATCHDOG, host, port);
}

fn run_watchdog_loop(budget: WatchdogBudget, host: &str, port: u16) -> ! {
    let mut consecutive_failures = 0u32;
    let mut armed = false;
    let mut last_error = String::new();
    loop {
        std::thread::sleep(budget.interval);
        let shutting_down = crate::process_signals::received_shutdown_signal().is_some();
        let outcome = probe_health_within(host, port, budget.timeout);
        if let Err(error) = &outcome {
            last_error = error.clone();
        }
        let action = watchdog_action_within(
            outcome.is_ok(),
            consecutive_failures + u32::from(outcome.is_err()),
            armed,
            shutting_down,
            budget.failures_before_exit,
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
                    "health recovered",
                    budget.label,
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
                    "label": budget.label,
                    "port": port,
                    "consecutiveFailures": consecutive_failures + 1,
                    "failuresBeforeExit": budget.failures_before_exit,
                    "lastError": last_error,
                    "exitCode": WEDGED_EXIT_CODE,
                });
                crate::debug_logging::log_lifecycle_always(
                    "wedged, exiting so the next command can start a live one",
                    budget.label,
                    Some(detail.clone()),
                );
                eprintln!("aimux {} wedged and is exiting: {detail}", budget.label);
                std::process::exit(WEDGED_EXIT_CODE);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The project service must actually ARM one, before it enters the serve
    /// loop.
    ///
    /// A budget nobody spawns is the shape this whole item is about: the
    /// daemon has had this watchdog all along and the service armed nothing.
    /// Driving a real wedge would take a service whose accept loop is dead, so
    /// the call site is pinned at the source, the way this crate already pins
    /// the logging opt-in's position.
    #[test]
    fn the_project_service_arms_a_watchdog_before_it_serves() {
        let source = include_str!("../project_service/process.rs");
        let armed = source
            // `rfind`, not `find`: a doc comment naming the same symbol would
            // otherwise satisfy this, and a gate a comment can satisfy is not
            // a gate.
            .rfind("spawn_health_watchdog(")
            .expect("the project service still arms a health watchdog");
        let serving = source
            .find("block_on(serve_project_service_listener_until(")
            .expect("the project service still enters its serve loop");

        assert!(
            armed < serving,
            "a watchdog armed after the serve loop would never start: armed at \
             {armed}, serving at {serving}"
        );
        assert!(
            source[armed..armed + 200].contains("PROJECT_SERVICE_WATCHDOG"),
            "the service must arm its own budget, not the daemon's"
        );
    }

    /// The project service gets a budget of its own, and it must be the more
    /// patient one. `/health` there builds scheduler diagnostics on a
    /// two-worker runtime, so its latency tracks contention -- ending a
    /// service that is merely starved of CPU would be worse than the wedge
    /// this exists for.
    // These ARE constants, and that is the point: the test states the
    // relationship between two tunables so changing one in isolation fails.
    #[allow(clippy::assertions_on_constants)]
    #[test]
    fn a_project_service_is_given_more_patience_than_the_daemon() {
        assert!(
            PROJECT_SERVICE_WATCHDOG.failures_before_exit > DAEMON_WATCHDOG.failures_before_exit,
            "a service under load must get more strikes than the daemon"
        );
        assert!(
            PROJECT_SERVICE_WATCHDOG.timeout > DAEMON_WATCHDOG.timeout,
            "and longer to answer each one"
        );
        assert!(
            PROJECT_SERVICE_WATCHDOG.interval >= DAEMON_WATCHDOG.interval,
            "and no more often than the daemon is asked"
        );
        // The incident lasted 4d19h. Anything under a couple of minutes risks
        // a loaded service; anything over an hour is not a liveness check.
        let patience =
            PROJECT_SERVICE_WATCHDOG.interval * PROJECT_SERVICE_WATCHDOG.failures_before_exit;
        assert!(
            patience >= Duration::from_secs(180) && patience <= Duration::from_secs(1_800),
            "the service's patience is {patience:?}, which is outside the useful range"
        );
    }

    /// The decision must honour the budget it is given, not the daemon's.
    #[test]
    fn a_service_within_its_own_budget_is_not_ended() {
        let strikes = PROJECT_SERVICE_WATCHDOG.failures_before_exit;
        for failures in FAILURES_BEFORE_EXIT..strikes {
            assert_eq!(
                watchdog_action_within(false, failures, true, false, strikes),
                WatchdogAction::Wait,
                "{failures} misses is still inside the service's budget"
            );
        }
        assert_eq!(
            watchdog_action_within(false, strikes, true, false, strikes),
            WatchdogAction::ExitWedged,
            "and the budget is reached eventually"
        );
    }

    /// A service that has never answered is starting, however long it takes.
    #[test]
    fn a_service_that_has_never_answered_is_never_ended() {
        let strikes = PROJECT_SERVICE_WATCHDOG.failures_before_exit;
        for failures in 0..=strikes + 5 {
            assert_eq!(
                watchdog_action_within(false, failures, false, false, strikes),
                WatchdogAction::Wait
            );
        }
    }

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
