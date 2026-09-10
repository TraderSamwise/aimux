fn main() {
    println!("cargo:rerun-if-env-changed=AIMUX_BUILD_PROFILE");
    println!("cargo:rerun-if-env-changed=AIMUX_RELEASE_BUILD_STAMP");
    let build_stamp = std::env::var("AIMUX_RELEASE_BUILD_STAMP").unwrap_or_default();
    println!(
        "cargo:rustc-env=AIMUX_EMBEDDED_BUILD_STAMP={}",
        build_stamp.trim()
    );
}
