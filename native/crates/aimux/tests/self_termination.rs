#![cfg(unix)]

//! The two last-resort exits, actually executed.
//!
//! Both defences added for the 4d19h wedge end the process, and until this
//! file nothing in the suite ran either `std::process::exit`. A review deleted
//! both calls and pointed the watchdog at a port nothing serves; all three
//! mutations left every test green, so the branch's whole claim passed with
//! the fix removed.
//!
//! Each case runs a CHILD process: this same test binary, re-invoked with one
//! test selected and a mode in the environment. The parent asserts the exit
//! code, which is the only thing that proves the exit happened.

use aimux::daemon::watchdog::{WEDGED_EXIT_CODE, WatchdogBudget, spawn_health_watchdog};
use aimux::process_signals::{
    SHUTDOWN_ESCALATION_EXIT_CODE, TERMINATION_SIGNALS, install_shutdown_signal_flag,
    spawn_shutdown_escalation,
};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

const MODE: &str = "AIMUX_TEST_SELF_TERMINATION";

/// Small enough to run inside a test, same shape as production's.
fn quick_budget() -> WatchdogBudget {
    WatchdogBudget {
        label: "project-service",
        interval: Duration::from_millis(200),
        timeout: Duration::from_millis(400),
        failures_before_exit: 2,
    }
}

fn child_mode() -> Option<String> {
    std::env::var(MODE).ok()
}

fn spawn_child(mode: &str, test_name: &str) -> Child {
    Command::new(std::env::current_exe().expect("this test binary"))
        .args(["--exact", test_name, "--nocapture", "--test-threads=1"])
        .env(MODE, mode)
        .spawn()
        .expect("run the child")
}

fn wait_for_exit(child: &mut Child, within: Duration) -> Option<i32> {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().expect("poll the child") {
            return status.code();
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

/// Answer `GET /health` for the first `healthy_answers` callers, then accept
/// and close without answering -- the wedge's own shape.
fn serve_then_wedge(listener: TcpListener, healthy_answers: usize) {
    let mut answered = 0;
    while let Ok((mut stream, _)) = listener.accept() {
        let mut scratch = [0_u8; 1024];
        let _ = stream.read(&mut scratch);
        if answered < healthy_answers {
            let payload = format!("{{\"ok\":true,\"pid\":{}}}", std::process::id());
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                    payload.len()
                )
                .as_bytes(),
            );
            let _ = stream.flush();
            answered += 1;
        }
    }
}

/// A shutdown signal that nothing acts on must end the process.
#[test]
fn an_unhonoured_shutdown_signal_ends_the_process() {
    if child_mode().is_some() {
        return;
    }
    let mut child = spawn_child("escalation", "the_child_that_ignores_a_shutdown_signal");
    let code = wait_for_exit(&mut child, Duration::from_secs(10));
    let _ = child.kill();
    let _ = child.wait();

    assert_eq!(
        code,
        Some(SHUTDOWN_ESCALATION_EXIT_CODE),
        "a process that ignored a shutdown signal must be ended by the escalation"
    );
}

#[test]
fn the_child_that_ignores_a_shutdown_signal() {
    if child_mode().as_deref() != Some("escalation") {
        return;
    }
    let _guard = install_shutdown_signal_flag(TERMINATION_SIGNALS).expect("install handlers");
    spawn_shutdown_escalation("project-service", Duration::from_millis(300));
    // SAFETY: raising a signal this process has just installed a handler for.
    unsafe { libc::raise(libc::SIGTERM) };
    // And then behave exactly like the wedged service: never act on it.
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// A process that answered once and then stopped must end itself.
#[test]
fn a_process_that_stops_answering_ends_itself() {
    if child_mode().is_some() {
        return;
    }
    let mut child = spawn_child("watchdog", "the_child_that_stops_answering");
    let code = wait_for_exit(&mut child, Duration::from_secs(15));
    let _ = child.kill();
    let _ = child.wait();

    assert_eq!(
        code,
        Some(WEDGED_EXIT_CODE),
        "a process holding its port and answering nothing must end itself"
    );
}

#[test]
fn the_child_that_stops_answering() {
    if child_mode().as_deref() != Some("watchdog") {
        return;
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind loopback");
    let port = listener.local_addr().expect("local addr").port();
    spawn_health_watchdog(quick_budget(), "127.0.0.1".to_owned(), port);
    // One good answer arms it; after that the port is held and silent.
    serve_then_wedge(listener, 1);
}

/// The inverse, and the one that matters most: a process that keeps answering
/// must never be ended. A watchdog that restarts healthy services under load
/// would be worse than the wedge it exists for.
#[test]
fn a_process_that_keeps_answering_is_left_alone() {
    if child_mode().is_some() {
        return;
    }
    let mut child = spawn_child("healthy", "the_child_that_keeps_answering");
    // Comfortably past the budget's exit point: two strikes, 200ms apart.
    let code = wait_for_exit(&mut child, Duration::from_secs(3));
    let _ = child.kill();
    let _ = child.wait();

    assert_eq!(
        code, None,
        "a healthy process was ended by its own watchdog"
    );
}

#[test]
fn the_child_that_keeps_answering() {
    if child_mode().as_deref() != Some("healthy") {
        return;
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind loopback");
    let port = listener.local_addr().expect("local addr").port();
    spawn_health_watchdog(quick_budget(), "127.0.0.1".to_owned(), port);
    serve_then_wedge(listener, usize::MAX);
}

/// A watchdog pointed at a port this process does not serve can never arm,
/// which is how a disarmed defence hides: nothing fails, nothing is defended.
#[test]
fn a_watchdog_on_the_wrong_port_never_arms() {
    if child_mode().is_some() {
        return;
    }
    let mut child = spawn_child("wrong-port", "the_child_watched_on_the_wrong_port");
    let code = wait_for_exit(&mut child, Duration::from_secs(3));
    let _ = child.kill();
    let _ = child.wait();

    assert_ne!(
        code,
        Some(WEDGED_EXIT_CODE),
        "a watchdog that never answered cannot have armed, so this exit means \
         the arming condition is wrong"
    );
}

#[test]
fn the_child_watched_on_the_wrong_port() {
    if child_mode().as_deref() != Some("wrong-port") {
        return;
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind loopback");
    let port = listener.local_addr().expect("local addr").port();
    // Deliberately the wrong port: nothing answers there, so `armed` stays
    // false and the strikes never become fatal.
    spawn_health_watchdog(quick_budget(), "127.0.0.1".to_owned(), port.wrapping_add(1));
    serve_then_wedge(listener, usize::MAX);
}

/// Sanity on the fixture itself: the served port really does answer 200, so a
/// watchdog failing against it would mean something.
#[test]
fn the_fixture_answers_a_health_probe() {
    if child_mode().is_some() {
        return;
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind loopback");
    let port = listener.local_addr().expect("local addr").port();
    std::thread::spawn(move || serve_then_wedge(listener, 1));

    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        .expect("write");
    let mut answer = String::new();
    stream.read_to_string(&mut answer).expect("read");
    assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
}
