//! The render loop, driven.
//!
//! Every predicate in `run_native_dashboard_internal` was gated and none was
//! ever executed by a test: the loop owns real stdin and only returns under
//! `--once`, where `rendered_once` is false and the cached-frame path is
//! unreachable by construction. Setting `input_driven: false`, deleting the
//! deferral arming, or deleting any of the ten `cacheable_input = false` lines
//! all left the suite green -- and the first of those is exactly the latency
//! regression PR 388 fixed.
//!
//! So this stands in for what the loop reaches for -- keys, snapshots, when to
//! stop, and where frames go -- and asserts what the loop does with them.
//!
//! The cache window is real elapsed time, and the two edges are close together:
//! a frame an input asked for waits out `DASHBOARD_MIN_INPUT_FRAME_GAP` (50ms),
//! and a deferred fetch comes due after `DASHBOARD_DEFERRED_REFRESH_BUDGET`
//! (150ms) of idle. The loop's own bottom-of-pass sleep is 50ms, so a script
//! here only adds the margin that puts each idle between the two -- see
//! `NO_EXTRA_IDLE`. Land under 50ms and no frame goes up; land over 150ms and
//! the fetch is forced and the load count says nothing about the cache.

use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aimux::dashboard_controller::DashboardKey;
use aimux::dashboard_internal::{
    DashboardLoopSeams, DashboardSnapshotLoad, NativeDashboardOptions,
    run_native_dashboard_with_seams,
};
use aimux::dashboard_model::{DesktopStateGoldenFixture, DesktopStateSnapshot};

const GOLDEN: &str = include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json");

/// Why a keypress poll adds no delay of its own.
///
/// The loop sleeps `DASHBOARD_KEY_POLL_INTERVAL` (50ms) at the bottom of every
/// pass -- `wait_on_stdin` is false here, so `wait_for_dashboard_keys` takes its
/// sleep branch -- and `thread::sleep` only ever overshoots. So the idle between
/// two frames is already over the 50ms `DASHBOARD_MIN_INPUT_FRAME_GAP` without
/// help, and the lower edge needs no margin at all. The only edge load can push
/// us across is the 150ms `DASHBOARD_DEFERRED_REFRESH_BUDGET` above, so every
/// millisecond added here is headroom spent for nothing. An earlier revision
/// added 70ms, putting each idle at ~120ms with 30ms to spare; this leaves ~100.
const NO_EXTRA_IDLE: u64 = 0;

fn snapshot() -> DesktopStateSnapshot {
    serde_json::from_str::<DesktopStateGoldenFixture>(GOLDEN)
        .expect("valid desktop-state fixture")
        .runtime_light
}

/// Swallows the frames and the terminal guard's control codes, so a driven loop
/// does not paint over the test runner's own output.
struct Sink;

impl Write for Sink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct Driven {
    loads: usize,
    frames: usize,
}

/// One iteration's worth of input: how long to idle before offering it, and
/// what to offer. An empty key list is an idle poll.
type Poll = (u64, Vec<DashboardKey>);

/// Run the loop over a fixed script of polls, and stop when it runs out.
///
/// `stop` is driven from the same script rather than a counter of its own -- an
/// independent counter is how the first version of this file ended the loop
/// after one iteration and read none of the keys it was handing over.
fn drive(polls: Vec<Poll>) -> Driven {
    // Counted, not named after the script length. Integration binaries do not
    // get `--test-threads=1` -- `native-test-runner.py` adds it only for unit
    // tests -- so these run as concurrent threads, and two scripts of the same
    // length shared a directory that each `drive` removes. The poll counts
    // happen to be distinct today; the counter is what makes that not matter.
    static NEXT_ROOT: AtomicUsize = AtomicUsize::new(0);
    let root = std::env::temp_dir().join(format!(
        "aimux-render-loop-{}-{}",
        std::process::id(),
        NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).expect("project root");

    let script = Arc::new(Mutex::new(std::collections::VecDeque::from(polls)));
    let key_script = Arc::clone(&script);
    let loads = Arc::new(AtomicUsize::new(0));
    let load_counter = Arc::clone(&loads);
    let frames = Arc::new(AtomicUsize::new(0));
    let frame_counter = Arc::clone(&frames);

    let seams = DashboardLoopSeams {
        keys: Box::new(move || {
            let next = key_script.lock().expect("key script").pop_front();
            match next {
                Some((idle_ms, keys)) => {
                    // Slept here rather than between iterations: this stands in
                    // for a terminal with nothing on it, which is exactly the
                    // wait the real key read does.
                    std::thread::sleep(Duration::from_millis(idle_ms));
                    keys
                }
                None => Vec::new(),
            }
        }),
        snapshot: Box::new(move || {
            load_counter.fetch_add(1, Ordering::Relaxed);
            Ok(DashboardSnapshotLoad {
                snapshot: snapshot(),
                endpoint: None,
            })
        }),
        // Asked before the keys are read, so an empty script means this
        // iteration has nothing left to feed and the loop is done.
        stop: Box::new(move || script.lock().expect("stop script").is_empty()),
        output: Box::new(Sink),
        frame: Box::new(move || {
            frame_counter.fetch_add(1, Ordering::Relaxed);
        }),
    };

    let options = NativeDashboardOptions {
        project_root: root.clone(),
        // Set, and never read: the snapshot seam replaces the only loader that
        // would open it. What it buys is a loop that is not `live_dashboard`,
        // so each pass skips the tmux visibility read, the viewport recheck and
        // the runtime-guard probe. Measured on the live path those cost ~150ms
        // of subprocess per iteration, which both swamps the 150ms deferral
        // budget this file measures and is exactly the churn AGENTS.md says not
        // to put on a developer's machine. The decisions under test are the
        // same either way; `dashboard_render_source` never asks whether the
        // dashboard is live.
        desktop_state_file: Some(root.join("desktop-state.json")),
        cols: 120,
        rows: 40,
        once: false,
    };
    let outcome = run_native_dashboard_with_seams(options, Some(seams));
    // Before the assert, so a failing run does not leave the directory behind.
    let _ = std::fs::remove_dir_all(&root);
    outcome.expect("the driven loop returns");
    Driven {
        loads: loads.load(Ordering::Relaxed),
        frames: frames.load(Ordering::Relaxed),
    }
}

/// The loop reaches the snapshot loader and paints at all when driven.
///
/// This is the assertion that would have failed for every version of this file
/// before the seams existed: the loop could not be entered from a test, so
/// nothing in it was executed.
#[test]
fn the_render_loop_runs_and_paints_from_a_loaded_snapshot() {
    let driven = drive(vec![(0, vec![])]);
    assert_eq!(
        driven.loads, 1,
        "the first pass has no snapshot in hand, so it has to fetch one"
    );
    assert_eq!(
        driven.frames, 1,
        "and it paints the frame it fetched that snapshot for"
    );
}

/// Keypresses repaint from the snapshot already in hand.
///
/// `cacheable_input` exists so a held key does not cost one blocking fetch per
/// keystroke, which is the latency the cached path was added for. Nothing
/// proved the loader was skipped: deleting `input_driven` from the cacheable
/// predicate -- the exact regression PR 388 fixed -- left the suite green.
#[test]
fn keypresses_repaint_without_fetching_again() {
    let driven = drive(vec![
        (0, vec![]),
        (NO_EXTRA_IDLE, vec![DashboardKey::Down]),
        (NO_EXTRA_IDLE, vec![DashboardKey::Down]),
        (NO_EXTRA_IDLE, vec![DashboardKey::Up]),
    ]);

    assert_eq!(
        driven.loads, 1,
        "only the first pass may fetch; three keypresses must repaint from the \
         snapshot already in hand"
    );
    assert_eq!(driven.frames, 4, "and every one of them still gets a frame");
}

/// The deferred fetch is paid, not forgotten.
///
/// A cached frame arms `refresh_deferred_since`, and the frame that finds it
/// past the 150ms budget has to reload. Nothing proved the arming existed:
/// deleting it left the suite green, and the symptom is a dashboard that never
/// updates again after a keypress until the thirty-second fallback.
#[test]
fn the_fetch_a_cached_frame_skipped_comes_due_once_the_keys_stop() {
    let driven = drive(vec![
        (0, vec![]),
        (NO_EXTRA_IDLE, vec![DashboardKey::Down]),
        // Past DASHBOARD_DEFERRED_REFRESH_BUDGET (150ms) by a wide margin, so
        // the fetch the cached frame above deferred is owed. The 50ms the loop
        // sleeps anyway is on top of this, and the ceiling that would force a
        // refresh regardless is a full second away.
        (220, vec![]),
    ]);

    assert_eq!(
        driven.loads, 2,
        "the keypress repaints from cache, and the idle pass after it pays the \
         fetch that frame skipped"
    );
    // `loads == 2` alone does not separate this from a keypress that simply
    // refreshed: that also loads twice, but it leaves nothing deferred, so the
    // idle pass has no reason to render and there is no third frame.
    assert_eq!(
        driven.frames, 3,
        "the deferred fetch has to put a frame up, not just load"
    );
}

/// A key the cached frame cannot serve does fetch.
///
/// The inverse, and the reason the cached-path assertion is not enough on its
/// own: ten key handlers clear `cacheable_input`, and a cache that served
/// everything would satisfy that assertion while showing stale rows after the
/// action. Toggling offline agents changes which agents the loader is asked
/// for, so repainting the snapshot in hand would show the set just dismissed.
#[test]
fn a_key_that_changes_what_is_asked_for_fetches_again() {
    let driven = drive(vec![
        (0, vec![]),
        (NO_EXTRA_IDLE, vec![DashboardKey::ToggleOfflineAgents]),
    ]);

    assert_eq!(
        driven.loads, 2,
        "toggling offline agents must reload rather than repaint cache"
    );
}

/// The loop returns when it is told to, and promptly.
///
/// This replaces an assertion that read `elapsed < 10s` on the calling thread,
/// which a loop that never returned would hang before ever reaching. Run on its
/// own thread against a receive deadline, the same claim fails instead -- which
/// matters because nothing else bounds this loop's runtime and
/// `native-test-runner.py` runs each test binary without a timeout, so a `stop`
/// seam that stopped being consulted would take the whole suite down with it
/// rather than one test.
#[test]
fn the_loop_returns_promptly_when_told_to_stop() {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(drive(vec![(0, vec![]), (0, vec![])]).frames);
    });

    // Two passes at the loop's own 50ms cadence is ~100ms of work, so this is a
    // fiftyfold margin that still reports rather than hangs.
    let frames = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("the driven loop has to return, not own the terminal until killed");

    // And the second pass is not a free repaint: nothing asked for a frame and
    // nothing was deferred, so an idle poll on a fresh snapshot paints nothing.
    assert_eq!(
        frames, 1,
        "two idle passes should produce the first frame and no more"
    );
}
