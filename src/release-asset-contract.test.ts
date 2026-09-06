import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = () => readFileSync(join(process.cwd(), "scripts", "build-release-asset.sh"), "utf8");

describe("release asset native contract", () => {
  it("builds and packages the platform Rust CLI binary", () => {
    const body = script();

    expect(body).toContain("cargo build --manifest-path native/Cargo.toml -p aimux --release");
    expect(body).toContain('mkdir -p "$PKG_DIR/native/$PLATFORM-$ARCH"');
    expect(body).toContain('cp native/target/release/aimux "$PKG_DIR/native/$PLATFORM-$ARCH/aimux"');
    expect(body).toContain('chmod +x "$PKG_DIR/native/$PLATFORM-$ARCH/aimux"');
  });

  it("includes the Rust CLI binary in build-stamp coherence", () => {
    const body = script();

    expect(body).toContain('NATIVE_ARTIFACT="$PKG_DIR/native/$PLATFORM-$ARCH/aimux"');
    expect(body).toContain('BUILD_STAMP="$(artifact_mtime_ms "$NATIVE_ARTIFACT")-$(shasum -a 1 "$NATIVE_ARTIFACT"');
    expect(body).not.toContain("PKG_DIR/dist/launcher-bin.js");
    expect(body).not.toContain('MAIN_ARTIFACT_NAME="main.js"');
  });

  it("keeps the release tarball on the native runtime surface", () => {
    const body = script();

    expect(body).not.toContain("tsconfig.local.json");
    expect(body).not.toContain("check-local-build-boundary.mjs");
    expect(body).not.toContain("yarn install --production");
    expect(body).not.toContain("node_modules/node-pty");
    expect(body).not.toContain("cp -R bin dist");
    expect(body).not.toContain("scripts/installed-aimux-shim.sh");
  });
});
