fn main() {
    println!("cargo:rerun-if-env-changed=AIMUX_BUILD_PROFILE");
}
