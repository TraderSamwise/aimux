use aimux::dashboard_controller::DashboardKey;
use aimux::dashboard_terminal::{read_dashboard_key, read_dashboard_keys};
use std::io::{self, Read};

#[test]
fn read_dashboard_key_maps_bytes_from_reader() {
    let mut input = b"j".as_slice();
    assert_eq!(
        read_dashboard_key(&mut input).expect("read key"),
        Some(DashboardKey::Printable('j'))
    );
}

#[test]
fn read_dashboard_keys_preserves_pasted_printable_bytes() {
    let mut input = b"yarn dev".as_slice();
    assert_eq!(
        read_dashboard_keys(&mut input).expect("read keys"),
        vec![
            DashboardKey::Printable('y'),
            DashboardKey::Printable('a'),
            DashboardKey::Printable('r'),
            DashboardKey::Printable('n'),
            DashboardKey::Printable(' '),
            DashboardKey::Printable('d'),
            DashboardKey::Printable('e'),
            DashboardKey::Printable('v'),
        ]
    );
}

#[test]
fn read_dashboard_key_treats_would_block_as_no_key() {
    let mut input = WouldBlockReader;
    assert_eq!(read_dashboard_key(&mut input).expect("read key"), None);
}

struct WouldBlockReader;

impl Read for WouldBlockReader {
    fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::from(io::ErrorKind::WouldBlock))
    }
}

/// The loop asks this how long to hold before reading again. Three answers
/// matter, and two of them are the difference between a wait and a spin.
mod waiting_for_a_key {
    use aimux::dashboard_terminal::wait_for_input_on_fd;
    use std::io::Write;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::time::{Duration, Instant};

    /// Short, for the assertions that are lower bounds: a loaded runner can
    /// only make those longer, never shorter.
    const WAIT: Duration = Duration::from_millis(50);
    /// Long, for the one assertion that is an upper bound. A ready descriptor
    /// returns in microseconds, so only an implementation that waits anyway
    /// reaches anywhere near this -- and no amount of CI load does.
    const PATIENT_WAIT: Duration = Duration::from_secs(2);

    fn pipe() -> (OwnedFd, OwnedFd) {
        let mut fds = [0_i32; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0, "create pipe");
        unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
    }

    #[test]
    fn a_byte_already_there_returns_at_once() {
        let (read_end, write_end) = pipe();
        let mut writer = std::fs::File::from(write_end);
        writer.write_all(b"2").expect("write a key");

        let started = Instant::now();
        assert!(wait_for_input_on_fd(read_end.as_raw_fd(), PATIENT_WAIT));
        let waited = started.elapsed();
        assert!(
            waited < PATIENT_WAIT / 4,
            "waited {waited:?} for a key that was already there"
        );
    }

    #[test]
    fn an_idle_descriptor_waits_the_whole_interval() {
        let (read_end, _write_end) = pipe();

        let started = Instant::now();
        assert!(!wait_for_input_on_fd(read_end.as_raw_fd(), WAIT));
        assert!(
            started.elapsed() >= WAIT,
            "nothing to read means hold for the interval, not return early"
        );
    }

    /// The spin. `poll` reports a hung-up descriptor readable-ish immediately
    /// and forever, and the read behind it yields nothing -- so returning
    /// without holding would turn the render loop into a busy loop.
    #[test]
    fn a_hung_up_descriptor_still_holds_for_the_interval() {
        let (read_end, write_end) = pipe();
        drop(write_end);

        let started = Instant::now();
        assert!(!wait_for_input_on_fd(read_end.as_raw_fd(), WAIT));
        assert!(
            started.elapsed() >= WAIT,
            "a hangup must cost the same wait, or the loop spins at full speed"
        );
    }
}

/// The wait has to survive signals. SIGWINCH arrives many times a second while
/// a window is being dragged, `poll` returns EINTR on every one, and a wait
/// that gave up there would let the signal rate pace the render loop -- the one
/// thing the `sleep` it replaced could never do.
mod a_signal_is_not_a_key {
    use aimux::dashboard_terminal::wait_for_input_on_fd;
    use std::io::Write;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::time::{Duration, Instant};

    const WAIT: Duration = Duration::from_millis(200);
    const PATIENT_WAIT: Duration = Duration::from_secs(2);

    /// Left installed rather than restored: the default action for these is to
    /// terminate the process, so putting it back would make a stray signal
    /// during a later test fatal. A handler that does nothing cannot.
    extern "C" fn noop(_signal: i32) {}

    #[test]
    fn a_storm_of_signals_does_not_shorten_the_wait() {
        unsafe { libc::signal(libc::SIGUSR1, noop as libc::sighandler_t) };
        let mut fds = [0_i32; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0, "create pipe");
        let (read_end, _write_end) =
            unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };

        let waiting_thread = unsafe { libc::pthread_self() };
        let storm = std::thread::spawn(move || {
            let thread = waiting_thread as usize;
            for _ in 0..40 {
                std::thread::sleep(Duration::from_millis(2));
                unsafe { libc::pthread_kill(thread as libc::pthread_t, libc::SIGUSR1) };
            }
        });

        let started = Instant::now();
        let readable = wait_for_input_on_fd(read_end.as_raw_fd(), WAIT);
        let waited = started.elapsed();
        let _ = storm.join();

        assert!(!readable, "a signal is not a key");
        assert!(
            waited >= WAIT,
            "interrupted after {waited:?}, so the signal rate would pace the loop"
        );
    }

    /// And the key behind the signal is still seen. Treating EINTR as the end
    /// of the wait would hold the keypress until the interval ran out, which is
    /// the delay this whole change exists to remove -- just moved.
    #[test]
    fn a_key_arriving_after_a_signal_is_still_seen() {
        unsafe { libc::signal(libc::SIGUSR2, noop as libc::sighandler_t) };
        let mut fds = [0_i32; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0, "create pipe");
        let (read_end, write_end) =
            unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };

        let waiting_thread = unsafe { libc::pthread_self() } as usize;
        let sender = std::thread::spawn(move || {
            let mut writer = std::fs::File::from(write_end);
            std::thread::sleep(Duration::from_millis(10));
            unsafe { libc::pthread_kill(waiting_thread as libc::pthread_t, libc::SIGUSR2) };
            std::thread::sleep(Duration::from_millis(10));
            writer.write_all(b"1").expect("write a key");
            // Held open, so the key is readable rather than a hangup.
            std::thread::sleep(PATIENT_WAIT);
        });

        let started = Instant::now();
        let readable = wait_for_input_on_fd(read_end.as_raw_fd(), PATIENT_WAIT);
        let waited = started.elapsed();
        let _ = sender.join();

        assert!(readable, "the key behind the signal was never seen");
        assert!(
            waited < PATIENT_WAIT / 2,
            "waited {waited:?}, so the signal cost the keypress the rest of the interval"
        );
    }
}
