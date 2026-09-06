use aimux::local_ui_server::{
    LocalUiConfig, LocalUiServerOptions, is_loopback_host, local_config_javascript,
    start_local_ui_server,
};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn local_config_javascript_matches_typescript_contract() {
    let config = LocalUiConfig {
        connection_mode: "local".into(),
        daemon_url: "http://127.0.0.1:43190".into(),
    };

    assert_eq!(
        local_config_javascript(&config),
        "window.__AIMUX_LOCAL_CONFIG__={\"connectionMode\":\"local\",\"daemonUrl\":\"http://127.0.0.1:43190\"};\n"
    );
}

#[test]
fn loopback_host_validation_matches_local_ui_contract() {
    assert!(is_loopback_host("127.0.0.1"));
    assert!(is_loopback_host("localhost"));
    assert!(is_loopback_host("::1"));
    assert!(!is_loopback_host("0.0.0.0"));
    assert!(!is_loopback_host("192.168.1.2"));
}

#[test]
fn local_ui_server_serves_static_files_config_and_spa_fallback() {
    let root = temp_root("server");
    fs::create_dir_all(root.join("assets")).expect("create assets");
    fs::write(root.join("index.html"), "<main>Aimux</main>").expect("write index");
    fs::write(root.join("assets").join("app.js"), "console.log('aimux');").expect("write js");
    let server = start_local_ui_server(LocalUiServerOptions {
        host: "127.0.0.1".into(),
        port: 0,
        ui_root: root.clone(),
        config: LocalUiConfig {
            connection_mode: "local".into(),
            daemon_url: "http://127.0.0.1:43190".into(),
        },
    })
    .expect("start server");

    let index = request(server.port, "GET / HTTP/1.1\r\nHost: local\r\n\r\n");
    assert!(index.starts_with("HTTP/1.1 200 OK"));
    assert!(index.contains("Content-Type: text/html; charset=utf-8"));
    assert!(index.ends_with("<main>Aimux</main>"));

    let asset = request(
        server.port,
        "GET /assets/app.js HTTP/1.1\r\nHost: local\r\n\r\n",
    );
    assert!(asset.contains("Content-Type: text/javascript; charset=utf-8"));
    assert!(asset.contains("Cache-Control: public, max-age=31536000, immutable"));
    assert!(asset.ends_with("console.log('aimux');"));

    let config = request(
        server.port,
        "GET /aimux-local-config.js HTTP/1.1\r\nHost: local\r\n\r\n",
    );
    assert!(config.contains("Cache-Control: no-store"));
    assert!(config.ends_with(
        "window.__AIMUX_LOCAL_CONFIG__={\"connectionMode\":\"local\",\"daemonUrl\":\"http://127.0.0.1:43190\"};\n"
    ));

    let fallback = request(
        server.port,
        "GET /project/repo HTTP/1.1\r\nHost: local\r\n\r\n",
    );
    assert!(fallback.starts_with("HTTP/1.1 200 OK"));
    assert!(fallback.ends_with("<main>Aimux</main>"));

    let forbidden = request(
        server.port,
        "GET /%2e%2e/secret HTTP/1.1\r\nHost: local\r\n\r\n",
    );
    assert!(forbidden.starts_with("HTTP/1.1 403 Forbidden"));

    let _ = server.close();
    cleanup(root);
}

fn request(port: u16, request: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect server");
    stream.write_all(request.as_bytes()).expect("write request");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("read response");
    response
}

fn temp_root(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-local-ui-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    fs::create_dir_all(&path).expect("create temp root");
    path
}

fn cleanup(path: PathBuf) {
    let _ = fs::remove_dir_all(path);
}
