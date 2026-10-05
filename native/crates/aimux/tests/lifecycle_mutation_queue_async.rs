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
