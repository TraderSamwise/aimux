use aimux::expose_socket::{
    EXPOSE_SOCKET_HEADER_MAX_BYTES, expose_socket_path, parse_positive_header_integer,
    split_expose_header,
};
use std::path::PathBuf;

#[test]
fn split_header_waits_for_fifteen_lines_and_preserves_rest() {
    let fourteen = (0..14)
        .map(|index| format!("line-{index}\n"))
        .collect::<String>();
    assert!(split_expose_header(fourteen.as_bytes()).is_none());

    let mut input = (0..15)
        .map(|index| format!("line-{index}\r\n"))
        .collect::<String>()
        .into_bytes();
    input.extend_from_slice(b"\x1b[Arest\n");

    let parsed = split_expose_header(&input).expect("header");

    assert_eq!(parsed.header.len(), 15);
    assert_eq!(parsed.header[0], "line-0");
    assert_eq!(parsed.header[14], "line-14");
    assert_eq!(parsed.rest, b"\x1b[Arest\n");
}

#[test]
fn positive_header_integer_matches_parse_int_positive_behavior() {
    assert_eq!(parse_positive_header_integer(Some("12xyz")), Some(12));
    assert_eq!(parse_positive_header_integer(Some(" 9 ")), Some(9));
    assert_eq!(parse_positive_header_integer(Some("0")), None);
    assert_eq!(parse_positive_header_integer(Some("-5")), None);
    assert_eq!(parse_positive_header_integer(Some("")), None);
    assert_eq!(parse_positive_header_integer(None), None);
}

#[test]
fn long_project_state_dirs_publish_socket_path_in_tmp() {
    let short = PathBuf::from("/tmp/aimux-short-state");
    assert_eq!(expose_socket_path(&short), short.join("expose.sock"));

    let long = PathBuf::from(format!(
        "/tmp/{}",
        "a".repeat(EXPOSE_SOCKET_HEADER_MAX_BYTES / 40)
    ));
    let path = expose_socket_path(&long);
    assert!(path.starts_with(std::env::temp_dir()));
    assert!(path.to_string_lossy().contains("aimux-expose-"));
    assert!(path.to_string_lossy().ends_with(".sock"));
}
