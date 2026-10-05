//! The lifecycle queue, taken from async tasks on a runtime as small as the
//! project service's own.
//!
//! The queue serializes every lifecycle mutation, which is what the Node
//! original did with a promise chain. The Rust port waited on a `Condvar`
//! instead, so a waiter parked its thread — and the async lifecycle routes
//! (`agent.spawn`, `agent.stop`, `agent.kill`) await inside connection tasks on
//! a two-worker runtime. Three of them at once parked both workers while the
//! permit holder sat at an `.await` nothing could poll: no 409, no 429, no
//! timeout, wedged until the service was killed.
//!
//! These tests hold the queue from a two-worker runtime on purpose, because
//! that is the shape that wedged.

use std::sync::Arc;
use std::time::Duration;

use aimux::project_service::lifecycle_mutation_queue::{
    LifecycleMutationQueue, LifecycleTransitionInput,
};
use tokio::runtime::{Builder, Runtime};
use tokio::sync::oneshot;

/// As many workers as the project service runs (`ASYNC_RUNTIME_WORKER_THREADS`).
const PROJECT_SERVICE_WORKERS: usize = 2;

fn two_worker_runtime() -> Runtime {
    Builder::new_multi_thread()
        .worker_threads(PROJECT_SERVICE_WORKERS)
        .enable_time()
        .build()
        .expect("two-worker runtime")
}

fn agent_stop(session_id: &str) -> LifecycleTransitionInput {
    LifecycleTransitionInput::new("agent.stop", "agent").with_target_id(Some(session_id.to_owned()))
}

/// Spin on the queue's own diagnostics rather than a sleep: the assertion is
/// about what the queue reports, and a sleep long enough to be reliable is long
/// enough to hide the thing being measured.
fn wait_until(queue: &LifecycleMutationQueue, mut ready: impl FnMut(&serde_json::Value) -> bool) {
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        let diagnostics = queue.diagnostics("/repo");
        if ready(&diagnostics) {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!(
        "queue never reached the expected state: {}",
        queue.diagnostics("/repo")
    );
}

#[test]
fn three_mutations_of_three_agents_all_finish_on_a_two_worker_runtime() {
    let runtime = two_worker_runtime();
    let queue = LifecycleMutationQueue::new(32);
    let (release_holder, holder_released) = oneshot::channel::<()>();

    let holder_queue = queue.clone();
    let holder = runtime.spawn(async move {
        let mut permit = holder_queue
            .begin_async(Some(agent_stop("holder")))
            .await
            .expect("holder takes the queue");
        let started_at = std::time::Instant::now();
        // The holder is suspended here. Under the blocking wait this is the
        // await that could never be polled again.
        holder_released.await.expect("holder is released");
        permit.succeed(started_at);
        "holder"
    });
    wait_until(&queue, |diagnostics| {
        diagnostics["telemetry"]["started"] == 1
    });

    let waiters = ["second", "third"]
        .into_iter()
        .map(|session_id| {
            let queue = queue.clone();
            runtime.spawn(async move {
                let mut permit = queue
                    .begin_async(Some(agent_stop(session_id)))
                    .await
                    .expect("waiter takes the queue");
                let started_at = std::time::Instant::now();
                permit.succeed(started_at);
                session_id
            })
        })
        .collect::<Vec<_>>();
    // Both waiters are in the queue, so under the blocking wait both workers
    // are now spent and the holder above is unreachable.
    wait_until(&queue, |diagnostics| diagnostics["queuedCount"] == 3);

    release_holder.send(()).expect("release the holder");
    // aimux-async-seam: test - sync test drives the async queue on its own runtime
    let finished = runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut finished = vec![holder.await.expect("holder task")];
            for waiter in waiters {
                finished.push(waiter.await.expect("waiter task"));
            }
            finished
        })
        .await
    });

    let finished = finished.expect("every mutation finishes; a timeout here is the wedge");
    assert_eq!(finished, vec!["holder", "second", "third"]);
    let diagnostics = queue.diagnostics("/repo");
    assert_eq!(diagnostics["queuedCount"], 0);
    assert_eq!(diagnostics["telemetry"]["succeeded"], 3);
    assert_eq!(diagnostics["telemetry"]["rejectedConflicts"], 0);
    assert_eq!(diagnostics["telemetry"]["rejectedQueueFull"], 0);
}

#[test]
fn mutations_of_different_agents_still_run_one_at_a_time() {
    let runtime = two_worker_runtime();
    let queue = LifecycleMutationQueue::new(32);
    let order = Arc::new(std::sync::Mutex::new(Vec::<&'static str>::new()));
    let (release_holder, holder_released) = oneshot::channel::<()>();

    let holder_queue = queue.clone();
    let holder_order = Arc::clone(&order);
    let holder = runtime.spawn(async move {
        let mut permit = holder_queue
            .begin_async(Some(agent_stop("one")))
            .await
            .expect("holder takes the queue");
        let started_at = std::time::Instant::now();
        holder_order.lock().expect("order").push("one:start");
        holder_released.await.expect("holder is released");
        holder_order.lock().expect("order").push("one:end");
        permit.succeed(started_at);
    });
    wait_until(&queue, |diagnostics| {
        diagnostics["telemetry"]["started"] == 1
    });

    let second_queue = queue.clone();
    let second_order = Arc::clone(&order);
    let second = runtime.spawn(async move {
        let mut permit = second_queue
            .begin_async(Some(agent_stop("two")))
            .await
            .expect("second takes the queue");
        let started_at = std::time::Instant::now();
        second_order.lock().expect("order").push("two:start");
        permit.succeed(started_at);
    });
    wait_until(&queue, |diagnostics| diagnostics["queuedCount"] == 2);

    assert_eq!(
        order.lock().expect("order").clone(),
        vec!["one:start"],
        "a second agent's mutation must not start while the first holds the queue"
    );

    release_holder.send(()).expect("release the holder");
    // aimux-async-seam: test - sync test drives the async queue on its own runtime
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(10), async {
            holder.await.expect("holder task");
            second.await.expect("second task");
        })
        .await
        .expect("both finish")
    });

    assert_eq!(
        order.lock().expect("order").clone(),
        vec!["one:start", "one:end", "two:start"]
    );
}

#[test]
fn a_caller_that_hangs_up_while_waiting_gives_its_agent_back() {
    let runtime = two_worker_runtime();
    let queue = LifecycleMutationQueue::new(32);
    let (release_holder, holder_released) = oneshot::channel::<()>();

    let holder_queue = queue.clone();
    let holder = runtime.spawn(async move {
        let mut permit = holder_queue
            .begin_async(Some(agent_stop("holder")))
            .await
            .expect("holder takes the queue");
        let started_at = std::time::Instant::now();
        holder_released.await.expect("holder is released");
        permit.succeed(started_at);
    });
    wait_until(&queue, |diagnostics| {
        diagnostics["telemetry"]["started"] == 1
    });

    // The async lifecycle route races its own future against the client's
    // socket, so a caller that gives up while queued drops this future at the
    // acquire. Nothing ran, so the agent must be free for the next attempt.
    let abandoned_queue = queue.clone();
    let abandoned = runtime.spawn(async move {
        abandoned_queue
            .begin_async(Some(agent_stop("abandoned")))
            .await
            .map(|_| ())
    });
    wait_until(&queue, |diagnostics| diagnostics["queuedCount"] == 2);
    abandoned.abort();
    wait_until(&queue, |diagnostics| diagnostics["queuedCount"] == 1);

    let diagnostics = queue.diagnostics("/repo");
    let claimed = diagnostics["activeTargets"]
        .as_array()
        .expect("activeTargets")
        .iter()
        .filter_map(|target| target["key"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        claimed,
        vec!["agent:holder"],
        "the abandoned agent must not stay claimed, or every later mutation of it is refused"
    );

    release_holder.send(()).expect("release the holder");
    // aimux-async-seam: test - sync test drives the async queue on its own runtime
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(10), holder)
            .await
            .expect("holder finishes")
            .expect("holder task")
    });

    // Proving the point: the same agent can be taken again afterwards.
    // aimux-async-seam: test - sync test drives the async queue on its own runtime
    runtime.block_on(async {
        let mut permit = queue
            .begin_async(Some(agent_stop("abandoned")))
            .await
            .expect("the abandoned agent is free to retry");
        permit.succeed(std::time::Instant::now());
    });
}

#[test]
fn settling_a_mutation_admits_the_next_one_before_its_caller_returns() {
    let runtime = two_worker_runtime();
    let queue = LifecycleMutationQueue::new(32);

    // aimux-async-seam: test - sync test drives the async queue on its own runtime
    runtime.block_on(async {
        let mut holder = queue
            .begin_async(Some(agent_stop("one")))
            .await
            .expect("holder takes the queue");
        let waiting = {
            let queue = queue.clone();
            tokio::spawn(async move {
                let mut permit = queue
                    .begin_async(Some(agent_stop("two")))
                    .await
                    .expect("waiter takes the queue");
                permit.succeed(std::time::Instant::now());
            })
        };
        // The async route settles its permit and then awaits a statusline
        // refresh with the permit still in scope. The next mutation must not
        // wait for that refresh.
        holder.succeed(std::time::Instant::now());
        tokio::time::timeout(Duration::from_secs(10), waiting)
            .await
            .expect("the next mutation starts as soon as this one settles")
            .expect("waiter task");
        drop(holder);
    });

    let diagnostics = queue.diagnostics("/repo");
    assert_eq!(diagnostics["queuedCount"], 0);
    assert_eq!(diagnostics["telemetry"]["succeeded"], 2);
}

#[test]
fn a_mutation_that_never_finishes_refuses_the_next_one_by_name() {
    let runtime = two_worker_runtime();
    let queue = LifecycleMutationQueue::with_wait_for_turn(32, Duration::from_millis(50));

    // aimux-async-seam: test - sync test drives the async queue on its own runtime
    runtime.block_on(async {
        let _stuck = queue
            .begin_async(Some(agent_stop("stuck")))
            .await
            .expect("the stuck mutation takes the queue");

        let Err(error) = queue.begin_async(Some(agent_stop("waiting"))).await else {
            panic!("the next mutation must not wait forever");
        };

        assert_eq!(
            error.status(),
            429,
            "a queue that cannot be entered is a retry, not a conflict"
        );
        let message = error.message();
        assert!(
            message.contains("agent.stop on stuck"),
            "the refusal must name what it waited on, not only that it gave up: {message}"
        );
        assert!(
            message.contains("waited"),
            "the refusal must say how long it waited: {message}"
        );

        // Giving up released the claim, so the refused agent can be tried
        // again rather than 409ing for the life of the process.
        let diagnostics = queue.diagnostics("/repo");
        let claimed = diagnostics["activeTargets"]
            .as_array()
            .expect("activeTargets")
            .iter()
            .filter_map(|target| target["key"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(claimed, vec!["agent:stuck"]);
        assert_eq!(diagnostics["queuedCount"], 1);
    });
}

#[test]
fn two_unnamed_mutations_queue_instead_of_refusing_each_other() {
    let runtime = two_worker_runtime();
    let queue = LifecycleMutationQueue::new(32);
    let (release_holder, holder_released) = oneshot::channel::<()>();
    let unnamed = || LifecycleTransitionInput::new("service.create", "service");

    let holder_queue = queue.clone();
    let holder = runtime.spawn(async move {
        let mut permit = holder_queue
            .begin_async(Some(unnamed()))
            .await
            .expect("the first service create takes the queue");
        let started_at = std::time::Instant::now();
        holder_released.await.expect("holder is released");
        permit.succeed(started_at);
    });
    wait_until(&queue, |diagnostics| {
        diagnostics["telemetry"]["started"] == 1
    });
    assert_eq!(
        queue.diagnostics("/repo")["activeTargets"],
        serde_json::json!([]),
        "a create names what it will make, not something to contend over"
    );

    let second_queue = queue.clone();
    let second = runtime.spawn(async move {
        let mut permit = second_queue
            .begin_async(Some(unnamed()))
            .await
            .expect("the second service create is queued, not refused");
        permit.succeed(std::time::Instant::now());
    });
    wait_until(&queue, |diagnostics| diagnostics["queuedCount"] == 2);

    release_holder.send(()).expect("release the holder");
    // aimux-async-seam: test - sync test drives the async queue on its own runtime
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(10), async {
            holder.await.expect("holder task");
            second.await.expect("second task");
        })
        .await
        .expect("both creates finish")
    });

    let diagnostics = queue.diagnostics("/repo");
    assert_eq!(diagnostics["telemetry"]["succeeded"], 2);
    assert_eq!(diagnostics["telemetry"]["rejectedConflicts"], 0);
    assert_eq!(diagnostics["queuedCount"], 0);
}

/// The inverse of the unnamed case: two mutations of the SAME agent must still
/// be refused, because that is what the conflict map is for.
#[test]
fn two_mutations_of_the_same_agent_are_still_refused() {
    let runtime = two_worker_runtime();
    // A short bound so the two refusals cannot be confused. Without the
    // conflict check the second call reaches the semaphore instead, waits on a
    // permit its own task holds, and comes back as HolderStuck -- so asserting
    // 409 here separates "refused for the right reason" from "deadlocked and
    // eventually gave up", and does it in milliseconds rather than 150s.
    let queue = LifecycleMutationQueue::with_wait_for_turn(32, Duration::from_millis(50));

    // aimux-async-seam: test - sync test drives the async queue on its own runtime
    runtime.block_on(async {
        let mut held = queue
            .begin_async(Some(agent_stop("codex-live")))
            .await
            .expect("the first stop takes the queue");

        let Err(error) = queue.begin_async(Some(agent_stop("codex-live"))).await else {
            panic!("a second mutation of the same agent must be refused");
        };
        assert_eq!(error.status(), 409);
        assert!(
            error.message().contains("codex-live"),
            "the refusal must name the agent: {}",
            error.message()
        );

        held.succeed(std::time::Instant::now());
    });

    let diagnostics = queue.diagnostics("/repo");
    assert_eq!(diagnostics["telemetry"]["rejectedConflicts"], 1);
    assert_eq!(diagnostics["telemetry"]["succeeded"], 1);
    assert_eq!(diagnostics["queuedCount"], 0);
}

/// The inverse of the bounded wait: a holder that finishes inside the bound
/// must not be called stuck. A worktree create doing a cold fetch is the
/// longest legitimate one, so a refusal here would be a regression against
/// work that used to succeed.
#[test]
fn a_slow_mutation_that_does_finish_is_not_called_stuck() {
    let runtime = two_worker_runtime();
    // Generously above anything load can cause: the holder is released as soon
    // as the test sees the waiter queued, so the only way to exceed this is a
    // 30s stall between two spins of `wait_until`. A tight bound here would
    // make the test flake on the very machine it is meant to protect.
    let queue = LifecycleMutationQueue::with_wait_for_turn(32, Duration::from_secs(30));
    let (release_holder, holder_released) = oneshot::channel::<()>();

    let holder_queue = queue.clone();
    let holder = runtime.spawn(async move {
        let mut permit = holder_queue
            .begin_async(Some(agent_stop("slow")))
            .await
            .expect("the slow mutation takes the queue");
        let started_at = std::time::Instant::now();
        holder_released.await.expect("holder is released");
        permit.succeed(started_at);
    });
    wait_until(&queue, |diagnostics| {
        diagnostics["telemetry"]["started"] == 1
    });

    let waiter_queue = queue.clone();
    let waiter = runtime.spawn(async move {
        waiter_queue
            .begin_async(Some(agent_stop("waiting")))
            .await
            .map(|mut permit| permit.succeed(std::time::Instant::now()))
            .map_err(|error| error.message())
    });
    wait_until(&queue, |diagnostics| diagnostics["queuedCount"] == 2);

    release_holder.send(()).expect("release the holder");

    // aimux-async-seam: test - sync test drives the async queue on its own runtime
    let outcome = runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(10), async {
            holder.await.expect("holder task");
            waiter.await.expect("waiter task")
        })
        .await
        .expect("both finish")
    });

    assert!(
        outcome.is_ok(),
        "a holder that finished inside the bound must not refuse its waiter: {outcome:?}"
    );
    assert_eq!(queue.diagnostics("/repo")["telemetry"]["succeeded"], 2);
}

/// A queue dying behind a stuck mutation must not read as a healthy one.
///
/// `maxQueuedMs` is the number that says how bad the waiting got, and it was
/// only recorded when a mutation actually started — so a queue where every
/// waiter timed out recorded nothing and looked fine.
#[test]
fn a_queue_nobody_can_enter_reports_how_long_waiters_waited() {
    let runtime = two_worker_runtime();
    let queue = LifecycleMutationQueue::with_wait_for_turn(32, Duration::from_millis(80));

    // aimux-async-seam: test - sync test drives the async queue on its own runtime
    runtime.block_on(async {
        let _stuck = queue
            .begin_async(Some(agent_stop("stuck")))
            .await
            .expect("the stuck mutation takes the queue");
        assert_eq!(
            queue.diagnostics("/repo")["telemetry"]["maxQueuedMs"],
            0,
            "nothing has waited yet"
        );

        let Err(_) = queue.begin_async(Some(agent_stop("waiting"))).await else {
            panic!("the waiter must be refused");
        };

        let waited = queue.diagnostics("/repo")["telemetry"]["maxQueuedMs"]
            .as_u64()
            .expect("maxQueuedMs is a number");
        assert!(
            waited >= 80,
            "the refused wait must be counted, or the dying queue reads as healthy: {waited}ms"
        );
    });
}
