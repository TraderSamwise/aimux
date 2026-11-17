//! `/health` is answered without a blocking thread.
//!
//! Every daemon route is dispatched through `spawn_blocking`, which is right
//! for a route that may take the global runtime mutex or shell out, and wrong
//! for the readiness probe: a probe that queues behind the pool reports on the
//! pool's health by refusing to answer.
//!
//! WHAT THIS DOES NOT DO, stated because the gap is the interesting part. It
//! does not drive a request through the listener with the pool full. I tried,
//! and it cannot be done from a test as the code stands:
//!
//!   - The public stream-level helpers
//!     (`handle_daemon_stream_with_metadata_and_interceptor_async` and
//!     friends) call their handler INLINE and say so in a comment, so a test
//!     through one of those exercises no hop at all and would pass whatever
//!     the listener did.
//!   - The hop only exists on the production path, reached through
//!     `serve_daemon_http_with_metadata_and_interceptor_until`, which uses
//!     `spawn_named` and therefore requires the SHARED aimux runtime. Building
//!     a tokio runtime with `max_blocking_threads(1)` and serving on it panics
//!     with "cannot initialize the shared async runtime from inside an async
//!     context", and the shared runtime sets no `max_blocking_threads`, so its
//!     pool is tokio's default 512 and is not injectable.
//!
//! So a route-level proof needs either 512 parked blocking threads -- a load
//! test, which belongs on a machine set aside for it -- or a
//! `max_blocking_threads` knob on the shared runtime. Neither is this change.
//! What is tested here is the predicate that decides the hop, and the fact
//! that it admits exactly one route.

use aimux::daemon::listener::answerable_without_a_blocking_thread;
use aimux::daemon::server::DaemonHttpRequest;

fn request(method: &str, path: &str) -> DaemonHttpRequest {
    DaemonHttpRequest {
        method: method.into(),
        path: path.into(),
        headers: Default::default(),
        body_chunks: Vec::new(),
        stopping: false,
        issued_at: "issued".into(),
    }
}

/// Only `GET /health` skips the blocking pool.
///
/// Every assertion here is a route that must KEEP the hop, because the hop is
/// what stops a route that takes the global mutex or shells out from blocking
/// an async worker. A predicate that admitted more would hand those routes a
/// way onto the async threads, which is a worse bug than the one it fixes.
#[test]
fn only_the_health_probe_is_answered_without_a_blocking_thread() {
    assert!(
        answerable_without_a_blocking_thread(&request("GET", "/health")),
        "the readiness probe must not need a blocking thread"
    );
    assert!(
        answerable_without_a_blocking_thread(&request("GET", "/health?verbose=1")),
        "a query string does not change which route this is"
    );

    for (method, path) in [
        // The routes that must keep the hop. Each of these can take the global
        // runtime mutex, read a file, or spawn a subprocess.
        ("GET", "/projects"),
        ("GET", "/core/task/list-text"),
        ("GET", "/core/agents/ps-text"),
        ("POST", "/core/loop/add-text"),
        ("GET", "/diagnostics"),
        // Not the health route, however much it looks like one.
        ("GET", "/healthz"),
        ("GET", "/health/detail"),
        ("GET", "/proxy/health"),
        // Right path, wrong method: the fast path in
        // `handle_daemon_runtime_request_with_mutex` is GET-only, so anything
        // else falls through to the locked dispatch and must keep the hop.
        ("POST", "/health"),
        ("DELETE", "/health"),
    ] {
        assert!(
            !answerable_without_a_blocking_thread(&request(method, path)),
            "{method} {path} was admitted to the async path; only GET /health is answered without a blocking thread, because only GET /health takes no lock and does no I/O"
        );
    }
}
