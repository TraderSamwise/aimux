use aimux::logs::{LogSelectionOptions, clear_log_file, parse_line_count, read_last_log_lines};
use aimux::paths::PathResolver;
use std::fs;
use std::path::PathBuf;

#[test]
fn line_count_matches_number_parse_int_fallbacks() {
    assert_eq!(parse_line_count(None), 80);
    assert_eq!(parse_line_count(Some("12")), 12);
    assert_eq!(parse_line_count(Some("12px")), 12);
    assert_eq!(parse_line_count(Some("  +7 ")), 7);
    assert_eq!(parse_line_count(Some("-5")), 80);
    assert_eq!(parse_line_count(Some("0")), 80);
    assert_eq!(parse_line_count(Some("abc")), 80);
}

#[test]
fn selected_log_path_matches_daemon_project_and_current_project_paths() {
    let mut resolver = PathResolver::new(
        "/repo/current",
        "/Users/tester",
        Some("/tmp/aimux-home".into()),
    );
    assert_eq!(
        aimux::logs::selected_log_path(
            &mut resolver,
            &LogSelectionOptions {
                daemon: true,
                project: Some("/ignored".into())
            }
        ),
        PathBuf::from("/tmp/aimux-home/daemon/logs/daemon.jsonl")
    );
    assert!(
        aimux::logs::selected_log_path(
            &mut resolver,
            &LogSelectionOptions {
                daemon: false,
                project: Some("/repo/other".into())
            }
        )
        .to_string_lossy()
        .ends_with("/logs/aimux.jsonl")
    );
}

#[test]
fn tail_and_clear_log_file_match_logs_helpers() {
    let root = std::env::temp_dir().join(format!("aimux-rust-logs-{}", std::process::id()));
    let path = root.join("nested/aimux.jsonl");
    fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
    fs::write(&path, "one\r\ntwo\nthree\n").expect("write log");

    assert_eq!(read_last_log_lines(&path, 2), "two\nthree");
    assert_eq!(read_last_log_lines(root.join("missing"), 2), "");
    clear_log_file(&path).expect("clear log");
    assert_eq!(fs::read_to_string(&path).expect("read cleared"), "");
    let _ = fs::remove_dir_all(root);
}
