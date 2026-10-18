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
    DashboardFrameSource, DashboardLoopSeams, DashboardRefreshDeferral, DashboardSnapshotLoad,
    NativeDashboardOptions, run_native_dashboard_with_seams,
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

/// Keeps what was painted, for the one claim that is about the frame itself
/// rather than about how many there were.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<String>>);

impl Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .expect("captured frame")
            .push_str(&String::from_utf8_lossy(buf));
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct Driven {
    loads: usize,
    frames: usize,
    cached_frames: usize,
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
    drive_with(polls, DashboardRefreshDeferral::PRODUCTION)
}

/// The same, with the deferral windows the loop judges a skipped fetch against.
///
/// Held still by the one test whose claim is about the cache rather than about
/// the clock: four passes of a loaded runner can outlast the 150ms budget and
/// the 1s ceiling both, and the fetch that forces is the budget working, not
/// the cache failing. Every other test here leaves them at the real values.
fn drive_with(polls: Vec<Poll>, deferral: DashboardRefreshDeferral) -> Driven {
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
    let cached_frames = Arc::new(AtomicUsize::new(0));
    let cached_counter = Arc::clone(&cached_frames);

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
        frame: Box::new(move |source| {
            if source == DashboardFrameSource::Cached {
                cached_counter.fetch_add(1, Ordering::Relaxed);
            }
            frame_counter.fetch_add(1, Ordering::Relaxed);
        }),
        deferral,
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
        cached_frames: cached_frames.load(Ordering::Relaxed),
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
    // The only test here that moves the windows, because it is the only one
    // whose claim is "all three keys came from the cache" -- a count that a
    // machine slow enough to outlast either window turns into two.
    //
    // What this proves is the WIRING: that the loop reaches the cacheable path
    // on a keypress and paints without fetching. The predicate's own terms are
    // pinned next to the function, in `dashboard_internal`'s
    // `everything_the_held_snapshot_cannot_show_refreshes_instead` -- deleting
    // `input_driven` fails there and, measured, not here, because every pass in
    // this script that asks for a frame is input-driven, so a predicate that
    // stopped reading the flag decides these four frames identically. An
    // earlier revision of this comment claimed that deletion "still takes this
    // to zero", which a reviewer disproved by running it.
    let driven = drive_with(
        vec![
            (0, vec![]),
            (NO_EXTRA_IDLE, vec![DashboardKey::Down]),
            (NO_EXTRA_IDLE, vec![DashboardKey::Down]),
            (NO_EXTRA_IDLE, vec![DashboardKey::Up]),
        ],
        DashboardRefreshDeferral {
            budget: Duration::from_secs(600),
            ceiling: Duration::from_secs(600),
        },
    );

    assert_eq!(driven.frames, 4, "every keypress still gets a frame");
    assert_eq!(
        driven.cached_frames, 3,
        "and the three keypresses have to repaint from the snapshot already in \
         hand, not fetch one each"
    );
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

/// `a` must not take the agent the pointer is on off the screen.
///
/// The filter's own tests call it directly; this is the only one that drives
/// the key through the loop, so it is what proves the call site passes the
/// pointed-at id at all. Replacing that argument with `None` fails here and
/// nowhere else.
#[test]
fn toggling_offline_agents_keeps_the_agent_the_pointer_is_on() {
    let painted = Captured::default();
    let frames = Arc::clone(&painted.0);
    let root = std::env::temp_dir().join(format!(
        "aimux-render-loop-kept-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).expect("project root");

    // One offline agent and nothing else, so the only row the filter could
    // keep is the one under the pointer.
    let mut fixture = snapshot();
    let mut offline = fixture.sessions[0].clone();
    offline.id = "claude-pointed".into();
    offline.label = Some("alpha".into());
    offline.status = aimux::dashboard_model::SessionStatus::Offline;
    offline.semantic = None;
    offline.overseer = None;
    offline.scribe = None;
    offline.project_control = None;
    offline.team = None;
    offline.worktree_path = None;
    // A second offline agent nobody is pointing at, so "the pointer kept it"
    // and "it was the only row" are different outcomes.
    let mut unpointed = offline.clone();
    unpointed.id = "claude-unpointed".into();
    unpointed.label = Some("beta".into());

    // The kept one is SECOND, so reading the first session instead of the
    // pointer is a different answer and this test can tell them apart.
    fixture.sessions = vec![unpointed, offline];
    fixture.teammates.clear();
    fixture.services.clear();
    fixture.worktree_groups.clear();

    let script = Arc::new(Mutex::new(std::collections::VecDeque::from(vec![
        // The first poll paints; keys are only dispatched once a frame is up.
        (0_u64, vec![]),
        (NO_EXTRA_IDLE, vec![DashboardKey::Down]),
        (NO_EXTRA_IDLE, vec![DashboardKey::ToggleOfflineAgents]),
        (NO_EXTRA_IDLE, vec![]),
    ])));
    let key_script = Arc::clone(&script);
    // Everything painted BEFORE the toggle shows the agent anyway, so the
    // buffer is emptied as the toggle is dispatched and the assertion reads
    // only what the filtered pass put up.
    let before_toggle = Arc::clone(&painted.0);
    let seam_snapshot = fixture.clone();
    let seams = DashboardLoopSeams {
        keys: Box::new(
            move || match key_script.lock().expect("key script").pop_front() {
                Some((idle_ms, keys)) => {
                    std::thread::sleep(Duration::from_millis(idle_ms));
                    if keys.contains(&DashboardKey::ToggleOfflineAgents) {
                        before_toggle.lock().expect("captured frame").clear();
                    }
                    keys
                }
                None => Vec::new(),
            },
        ),
        snapshot: Box::new(move || {
            Ok(DashboardSnapshotLoad {
                snapshot: seam_snapshot.clone(),
                endpoint: None,
            })
        }),
        stop: Box::new(move || script.lock().expect("stop script").is_empty()),
        output: Box::new(painted.clone()),
        frame: Box::new(|_| {}),
        deferral: DashboardRefreshDeferral::PRODUCTION,
    };

    let options = NativeDashboardOptions {
        project_root: root.clone(),
        desktop_state_file: Some(root.join("desktop-state.json")),
        cols: 120,
        rows: 40,
        once: false,
    };
    let outcome = run_native_dashboard_with_seams(options, Some(seams));
    let _ = std::fs::remove_dir_all(&root);
    outcome.expect("the driven loop returns");

    let painted = frames.lock().expect("captured frames").clone();
    assert!(
        !painted.is_empty(),
        "nothing was painted after the toggle, so this proves neither outcome"
    );
    assert!(
        painted.contains("alpha"),
        "the pointed-at agent went off screen when offline agents were hidden: {painted}"
    );
    assert!(
        !painted.contains("beta"),
        "the filter did not run: the agent nobody points at is still on screen"
    );
    assert!(
        painted.contains("1 hidden"),
        "the header must account for the one agent that was hidden: {painted}"
    );
}

/// A key pressed before the loop can act on it must not be thrown away.
///
/// Two passes used to read a key and drop it with the pass: one before the
/// first frame was painted, and one with no snapshot in hand. Over a link with
/// real latency those passes are most of the first second, which is Sam's
/// "on strix over mosh I have to hit the key many many times to get it to
/// register" -- and why typing into an agent is unaffected, since that is tmux
/// passthrough rather than this loop.
///
/// `ToggleOfflineAgents` is the key because its effect is countable: it changes
/// what the dashboard asks for, so a handled one costs a second load and a
/// dropped one costs nothing. The existing tests all press on the SECOND pass
/// for exactly this reason -- one of them says so.
#[test]
fn a_key_pressed_before_the_first_frame_is_still_acted_on() {
    let driven = drive(vec![
        // Pass one: nothing painted yet, no snapshot in hand. The key cannot be
        // dispatched here, and must not be lost here either.
        (0, vec![DashboardKey::ToggleOfflineAgents]),
        // Pass two: a frame is up and a snapshot is in hand.
        (NO_EXTRA_IDLE, vec![]),
    ]);

    assert_eq!(
        driven.loads, 2,
        "the key read before the first frame was dropped, so the dashboard never \
         reloaded for it"
    );
}

/// And a burst pressed into that window is still one burst, not a replay.
///
/// Held keys go through the same coalescing a fast typist's single read gets,
/// so three presses while the loop was getting ready do not become three
/// round trips.
#[test]
fn a_burst_pressed_before_the_first_frame_is_coalesced() {
    let driven = drive(vec![
        (
            0,
            vec![DashboardKey::Down, DashboardKey::Down, DashboardKey::Down],
        ),
        (NO_EXTRA_IDLE, vec![]),
    ]);

    assert_eq!(
        driven.loads, 1,
        "a held burst of pointer moves must repaint from the snapshot in hand, \
         not fetch one each"
    );
    assert!(
        driven.frames >= 1,
        "and the burst still produces a frame once the loop is ready"
    );
}

/// The tail of a batch that stopped partway is answered, not discarded.
///
/// A key whose effect changes what the next key would mean -- a request in
/// flight, a new surface -- stops the batch there. The batch was taken whole,
/// so abandoning the tail was a third way to lose a keypress, and holding keys
/// made the batches long enough to reach it.
///
/// `u` is the stopping key: jumping to the next agent needing attention
/// dispatches a request, which is what stops a batch. The toggle behind it is
/// the countable one, because it changes what the dashboard asks for -- so a
/// discarded tail leaves that reload unmade.
///
/// `Enter` looked like the stopping key and is not: with nothing selected in
/// this fixture it is ignored, both keys dispatch in one batch, and the
/// assertion held with the tail dropped. The mutation is what said so.
#[test]
fn the_tail_of_a_stopped_batch_is_answered_on_the_next_pass() {
    let driven = drive(vec![
        (
            0,
            vec![
                DashboardKey::Printable('u'),
                DashboardKey::ToggleOfflineAgents,
            ],
        ),
        (NO_EXTRA_IDLE, vec![]),
        (NO_EXTRA_IDLE, vec![]),
    ]);

    assert_eq!(
        driven.loads, 3,
        "the first pass fetches, the attention jump reloads, and the toggle \
         behind it has to reload too -- a dropped batch tail leaves this at two"
    );
}

/// A burst longer than the buffer applies none of it, rather than a fragment.
///
/// Keys arrive as sequences: the one that opens an overlay and the ones typed
/// into it. Keeping a suffix means applying the typing to whatever screen is
/// up instead, so an overflow drops the whole burst.
#[test]
fn a_burst_longer_than_the_buffer_is_dropped_whole() {
    let flood = (0..40)
        .map(|_| DashboardKey::ToggleOfflineAgents)
        .collect::<Vec<_>>();
    let driven = drive(vec![(0, flood), (NO_EXTRA_IDLE, vec![])]);

    assert_eq!(
        driven.loads, 1,
        "an overflowing burst must not reload at all: a trimmed buffer would \
         apply whatever suffix it kept"
    );
}

/// Enter already buffered behind the destructive key is not consent to the
/// preview that key has not shown yet. Exercise the real HTTP/loop boundary,
/// then prove that a later, fresh Enter still performs the confirmed action.
#[test]
fn bulk_graveyard_discards_buffered_confirmation_but_accepts_a_fresh_enter() {
    drive_bulk_graveyard_confirmation(false);
}

#[test]
fn bulk_graveyard_preview_waits_for_an_overlapping_tool_picker_to_close() {
    drive_bulk_graveyard_confirmation(true);
}

fn drive_bulk_graveyard_confirmation(overlapping_picker: bool) {
    use std::io::{BufRead, BufReader, Read};
    use std::net::TcpListener;
    use std::sync::atomic::AtomicBool;
    use std::time::Instant;

    use aimux::dashboard_client::ProjectServiceEndpoint;
    use aimux::project_api_contract::routes;
    use serde_json::{Value, json};

    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind preview server");
    listener
        .set_nonblocking(true)
        .expect("nonblocking listener");
    let endpoint = ProjectServiceEndpoint {
        host: "127.0.0.1".into(),
        port: listener.local_addr().expect("preview address").port(),
    };
    let finished = Arc::new(AtomicBool::new(false));
    let server_finished = Arc::clone(&finished);
    let release_preview = Arc::new(AtomicBool::new(false));
    let server_release_preview = Arc::clone(&release_preview);
    let preview_answered = Arc::new(AtomicBool::new(false));
    let server_preview_answered = Arc::clone(&preview_answered);
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let server_requests = Arc::clone(&requests);
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(7);
        while !server_finished.load(Ordering::Relaxed) && Instant::now() < deadline {
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(error) => panic!("accept preview request: {error}"),
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .expect("bounded request read");
            stream
                .set_write_timeout(Some(Duration::from_secs(1)))
                .expect("bounded response write");
            let mut reader = BufReader::new(&mut stream);
            let mut first_line = String::new();
            reader.read_line(&mut first_line).expect("request line");
            let mut content_length = 0;
            loop {
                let mut header = String::new();
                reader.read_line(&mut header).expect("request header");
                if header == "\r\n" || header.is_empty() {
                    break;
                }
                if let Some((name, value)) = header.split_once(':')
                    && name.eq_ignore_ascii_case("content-length")
                {
                    content_length = value.trim().parse::<usize>().expect("content length");
                }
            }
            let mut bytes = vec![0; content_length];
            reader.read_exact(&mut bytes).expect("request body");
            drop(reader);
            let mut is_preview = false;
            let response = if first_line.split_whitespace().nth(1)
                == Some(routes::graveyard_actions::OFFLINE_AGENTS)
            {
                let body: Value = serde_json::from_slice(&bytes).expect("JSON action body");
                server_requests.lock().expect("requests").push(body.clone());
                if body["dryRun"] == true {
                    is_preview = true;
                    while !server_release_preview.load(Ordering::Relaxed)
                        && !server_finished.load(Ordering::Relaxed)
                        && Instant::now() < deadline
                    {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    json!({"scope": "worktree", "path": "/preview-worktree",
                        "dryRun": true, "sessionIds": ["offline-confirmed"],
                        "summary": "Graveyard 1 offline agents?"})
                } else {
                    json!({"summary": "Graveyarded 1 offline agents; 0 failed",
                        "partialFailure": false, "moved": [{"sessionId": "offline-confirmed"}],
                        "failed": []})
                }
            } else {
                json!({"ok": true})
            }
            .to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(),
                response
            )
            .expect("preview response");
            if is_preview {
                server_preview_answered.store(true, Ordering::Relaxed);
            }
        }
    });

    let painted = Captured::default();
    let before_fresh_enter = Arc::new(Mutex::new(None));
    let before_fresh_output = Arc::clone(&before_fresh_enter);
    let before_fresh_requests = Arc::clone(&requests);
    let output_for_keys = Arc::clone(&painted.0);
    let picker_observation = Arc::new(Mutex::new(None));
    let picker_output = Arc::clone(&picker_observation);
    let stopped_requests = Arc::clone(&requests);
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut stage = 0;
    let mut answered_picker_polls = 0;
    let root = std::env::temp_dir().join(format!(
        "aimux-render-loop-bulk-confirm-{}-{}",
        std::process::id(),
        endpoint.port
    ));
    std::fs::create_dir_all(&root).expect("project root");
    let mut fixture = snapshot();
    fixture.agent_restore_offer = None;
    fixture.main_checkout_path = Some("/preview-worktree".into());
    fixture.sessions.clear();
    fixture.teammates.clear();
    fixture.services.clear();
    let mut group = fixture.worktree_groups[0].clone();
    group.path = Some("/preview-worktree".into());
    group.sessions.clear();
    group.services.clear();
    fixture.worktree_groups = vec![group];
    let seams = DashboardLoopSeams {
        keys: Box::new(move || {
            let output = output_for_keys.lock().expect("painted preview").clone();
            match stage {
                0 => {
                    stage = 1;
                    Vec::new()
                }
                1 => {
                    stage = 2;
                    vec![DashboardKey::Printable('K'), DashboardKey::Enter]
                }
                2 if overlapping_picker => {
                    stage = 3;
                    vec![DashboardKey::Printable('n')]
                }
                3 if !output.contains("SELECT TOOL") => Vec::new(),
                3 => {
                    release_preview.store(true, Ordering::Relaxed);
                    stage = 4;
                    vec![DashboardKey::Printable('y')]
                }
                4 => {
                    if preview_answered.load(Ordering::Relaxed) {
                        answered_picker_polls += 1;
                    }
                    if answered_picker_polls >= 2 {
                        *picker_output.lock().expect("picker observation") = Some(output);
                        stage = 5;
                        vec![DashboardKey::Back]
                    } else {
                        vec![DashboardKey::Printable('y')]
                    }
                }
                2 | 5 => {
                    release_preview.store(true, Ordering::Relaxed);
                    stage = 5;
                    if output.contains("GRAVEYARD OFFLINE AGENTS") {
                        *before_fresh_output.lock().expect("before fresh Enter") = Some((
                            output,
                            before_fresh_requests
                                .lock()
                                .expect("preview requests")
                                .clone(),
                        ));
                        stage = 6;
                    }
                    // Independent Enter reads before paint must not confirm
                    // a preview that arrived during this loop iteration.
                    vec![DashboardKey::Enter]
                }
                _ => Vec::new(),
            }
        }),
        snapshot: Box::new(move || {
            Ok(DashboardSnapshotLoad {
                snapshot: fixture.clone(),
                endpoint: Some(endpoint.clone()),
            })
        }),
        stop: Box::new(move || {
            stopped_requests.lock().expect("completed requests").len() >= 2
                || Instant::now() > deadline
        }),
        output: Box::new(painted),
        frame: Box::new(|_| {}),
        deferral: DashboardRefreshDeferral::PRODUCTION,
    };
    let outcome = run_native_dashboard_with_seams(
        NativeDashboardOptions {
            project_root: root.clone(),
            desktop_state_file: Some(root.join("desktop-state.json")),
            cols: 120,
            rows: 40,
            once: false,
        },
        Some(seams),
    );
    finished.store(true, Ordering::Relaxed);
    server.join().expect("preview server returns");
    let _ = std::fs::remove_dir_all(root);
    outcome.expect("driven bulk-confirmation loop returns");

    if overlapping_picker {
        let picker = picker_observation
            .lock()
            .expect("picker observation")
            .take()
            .expect("the preview response arrived while the picker was visible");
        assert!(picker.contains("SELECT TOOL"));
        assert!(!picker.contains("GRAVEYARD OFFLINE AGENTS"));
        assert!(!picker.contains("Graveyarding confirmed offline agents"));
    }

    let (preview_frame, earlier_requests) = before_fresh_enter
        .lock()
        .expect("before fresh Enter")
        .take()
        .expect("the fresh confirmation poll was reached");
    assert!(preview_frame.contains("GRAVEYARD OFFLINE AGENTS"));
    assert!(preview_frame.contains("Graveyard 1 offline agents?"));
    assert_eq!(
        earlier_requests.len(),
        1,
        "buffered Enter performed a mutation"
    );
    assert_eq!(earlier_requests[0]["dryRun"], true);
    assert!(
        !preview_frame.contains("Graveyarding confirmed offline agents"),
        "buffered Enter dismissed the confirmation before fresh input"
    );
    let requests = requests.lock().expect("all requests");
    assert_eq!(
        requests.len(),
        2,
        "fresh Enter must perform exactly one mutation"
    );
    assert_eq!(requests[1]["confirmed"], true);
    assert_eq!(requests[1]["sessionIds"], json!(["offline-confirmed"]));
}
