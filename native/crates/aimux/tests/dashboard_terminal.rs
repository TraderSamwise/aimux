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
