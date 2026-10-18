import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { auditRuntimeManifest, discoverRuntimeScripts, verifyRuntimePackagePaths } from "./audit-runtime-package.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = [];
const SOURCE = "native/crates/aimux/src/source.rs";
const RUNTIME_FILES = ["dist-ui", "native/darwin-arm64", "native/linux-x64", "native/linux-arm64"];

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function packageFiles(root, files) {
  write(root, "package.json", JSON.stringify({ name: "aimux-package-audit-fixture", files }));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aimux-runtime-package-"));
  roots.push(root);
  packageFiles(root, ["bin", "scripts/runtime.sh", ...RUNTIME_FILES]);
  write(root, "bin/aimux", "#!/bin/sh\n");
  write(root, SOURCE, 'fn launch() { packaged_script_path("runtime.sh"); }');
  write(root, "scripts/runtime.sh", "#!/bin/sh\n");
  copyFileSync(join(ROOT, "scripts/release-asset-matrix.py"), join(root, "scripts/release-asset-matrix.py"));
  write(
    root,
    ".github/workflows/release.yml",
    [
      "jobs:",
      "  release-assets:",
      "    strategy:",
      "      matrix:",
      "        include:",
      "          - platform: darwin",
      "            arch: arm64",
      "            variant: full",
      "            asset: fixture-darwin",
      "          - platform: linux",
      "            arch: x64",
      "            variant: full",
      "            asset: fixture-linux-x64",
      "          - platform: linux",
      "            arch: arm64",
      "            variant: full",
      "            asset: fixture-linux-arm64",
      "          - platform: linux",
      "            arch: x64",
      "            variant: local",
      "            asset: fixture-local",
      "    steps: []",
    ].join("\n"),
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime package resource discovery", () => {
  it("discovers newly added helper calls and direct literals without changing the gate", () => {
    const root = fixture();
    write(
      root,
      SOURCE,
      [
        'fn launch() { future_helper("future.sh"); repo_script_path("old.sh");',
        'resolve_repo_script_path("scripts/relative.py"); packaged_script_path("new.sh");',
        'let command = "node scripts/nested/worker.mjs"; }',
      ].join("\n"),
    );
    expect(discoverRuntimeScripts(root)).toEqual(
      new Set([
        "scripts/runtime.sh",
        "scripts/future.sh",
        "scripts/old.sh",
        "scripts/relative.py",
        "scripts/new.sh",
        "scripts/nested/worker.mjs",
      ]),
    );
    expect(auditRuntimeManifest(root)).toContain("package.json files does not cover runtime script: scripts/future.sh");
  });

  it("ignores test-only items with nested braces, comments, raw strings, and adjacent attributes", () => {
    const root = fixture();
    write(
      root,
      SOURCE,
      [
        "/* outer /* nested scripts/comment.sh */ comment */",
        '// packaged_script_path("comment.sh");',
        "#[cfg(test)] #[allow(dead_code)] mod tests {",
        "fn fixture() { let raw = r###\"} scripts/raw-test.sh {\"###; let brace = '}';",
        'if true { packaged_script_path("record-tool.sh"); } } }',
        '#[cfg(all(unix, test))] fn other_test() { packaged_script_path("other-test.sh"); }',
        '#[cfg(test)] const SCRIPT: &str = "scripts/test-constant.py";',
        'fn production() { let script = r#"scripts/production.py"#; }',
      ].join("\n"),
    );
    expect(discoverRuntimeScripts(root)).toEqual(new Set(["scripts/runtime.sh", "scripts/production.py"]));
  });

  it("retains code that can compile outside tests", () => {
    const root = fixture();
    write(
      root,
      SOURCE,
      [
        '#[cfg(any(test, feature = "release"))] fn conditional() { packaged_script_path("conditional.sh"); }',
        '#[cfg(not(test))] fn production() { packaged_script_path("production.sh"); }',
        '#[cfg(not(all(test, unix)))] fn possible() { packaged_script_path("possible.sh"); }',
      ].join("\n"),
    );
    expect(discoverRuntimeScripts(root)).toEqual(
      new Set(["scripts/runtime.sh", "scripts/conditional.sh", "scripts/production.sh", "scripts/possible.sh"]),
    );
  });

  it("limits the proof registry exception to the exact source and resource", () => {
    const root = fixture();
    write(
      root,
      "native/crates/aimux/src/contracts.rs",
      'const PROOFS: &[&str] = &["scripts/phase8-live-residuals.py", "scripts/future.sh"];',
    );
    expect(discoverRuntimeScripts(root)).toEqual(new Set(["scripts/runtime.sh", "scripts/future.sh"]));
    write(root, SOURCE, 'fn launch() { run("scripts/phase8-live-residuals.py"); }');
    expect(discoverRuntimeScripts(root).has("scripts/phase8-live-residuals.py")).toBe(true);
  });

  it("follows shell dependencies recursively even when the manifest omits them", () => {
    const root = fixture();
    write(root, "scripts/runtime.sh", '#!/bin/sh\nbash "$script_dir/nested/child.sh"\n');
    write(
      root,
      "scripts/nested/child.sh",
      '#!/bin/sh\npython3 "${SCRIPT_DIR}/worker.py"\nbash "$ROOT_DIR/scripts/other.sh"\n',
    );
    write(root, "scripts/nested/worker.py", "print('ready')\n");
    write(root, "scripts/other.sh", '#!/bin/sh\nsh "$script_dir/runtime.sh"\n');
    expect(discoverRuntimeScripts(root)).toEqual(
      new Set(["scripts/runtime.sh", "scripts/nested/child.sh", "scripts/nested/worker.py", "scripts/other.sh"]),
    );
    expect(auditRuntimeManifest(root)).toContain(
      "package.json files does not cover runtime script: scripts/nested/worker.py",
    );
  });

  it("ignores shell comments while retaining quoted resources and relative sibling commands", () => {
    const root = fixture();
    write(
      root,
      "scripts/runtime.sh",
      [
        "# scripts/comment.sh",
        'bash "$script_dir/child.sh" # scripts/inline-comment.sh',
        "sh ./relative.sh",
        "source sibling.sh",
      ].join("\n"),
    );
    expect(discoverRuntimeScripts(root)).toEqual(
      new Set(["scripts/runtime.sh", "scripts/child.sh", "scripts/relative.sh", "scripts/sibling.sh"]),
    );
  });

  it("keeps maintained manifest scripts and their sibling dependencies without a Rust caller", () => {
    const root = fixture();
    packageFiles(root, ["bin", "scripts/runtime.sh", "scripts/install-sweep.sh", "scripts/sweep.sh", ...RUNTIME_FILES]);
    write(root, "scripts/install-sweep.sh", "bash scripts/sweep.sh --apply\n");
    write(root, "scripts/sweep.sh", "#!/bin/sh\n");
    expect(discoverRuntimeScripts(root)).toEqual(
      new Set(["scripts/runtime.sh", "scripts/install-sweep.sh", "scripts/sweep.sh"]),
    );
    expect(auditRuntimeManifest(root)).toEqual([]);
  });

  it("discovers current runtime scripts while excluding source-only proof fixtures", () => {
    const paths = discoverRuntimeScripts(ROOT);
    expect(paths.has("scripts/tmux-control.sh")).toBe(true);
    expect(paths.has("scripts/tmux-open-hyperlink.sh")).toBe(true);
    expect(paths.has("scripts/cargo-sweep-stale-targets.sh")).toBe(true);
    expect(paths.has("scripts/install-cargo-sweep-schedule.sh")).toBe(true);
    expect(paths.has("scripts/phase8-live-residuals.py")).toBe(false);
    expect(paths.has("scripts/record-tool.sh")).toBe(false);
  });
});

describe("runtime package manifest and artifact gates", () => {
  it("accepts directory coverage without accepting similarly prefixed directories", () => {
    const root = fixture();
    packageFiles(root, ["bin", "scripts/", ...RUNTIME_FILES]);
    expect(auditRuntimeManifest(root)).toEqual([]);
    packageFiles(root, ["bin", "scripts-other", ...RUNTIME_FILES]);
    expect(auditRuntimeManifest(root)).toContain(
      "package.json files does not cover runtime script: scripts/runtime.sh",
    );
  });

  it("rejects a missing source file even when its manifest entry exists", () => {
    const root = fixture();
    rmSync(join(root, "scripts/runtime.sh"));
    expect(auditRuntimeManifest(root)).toEqual(["runtime script source is missing: scripts/runtime.sh"]);
  });

  it("rejects removal of a Linux native manifest entry using the actual matrix reader", () => {
    const root = fixture();
    packageFiles(root, ["bin", "dist-ui", "scripts/runtime.sh", "native/darwin-arm64", "native/linux-x64"]);
    expect(auditRuntimeManifest(root)).toEqual([
      "package.json files does not cover full release binary: native/linux-arm64/aimux",
    ]);
  });

  it("uses future matrix platforms without a copied platform list", () => {
    const root = fixture();
    const workflow = join(root, ".github/workflows/release.yml");
    writeFileSync(
      workflow,
      readFileSync(workflow, "utf8").replace(
        "    steps: []",
        [
          "          - platform: future",
          "            arch: newarch",
          "            variant: full",
          "            asset: future-asset",
          "    steps: []",
        ].join("\n"),
      ),
    );
    expect(auditRuntimeManifest(root)).toEqual([
      "package.json files does not cover full release binary: native/future-newarch/aimux",
    ]);
  });

  it("fails visibly if the matrix cannot be read", () => {
    const root = fixture();
    write(root, ".github/workflows/release.yml", "jobs: {}\n");
    expect(() => auditRuntimeManifest(root)).toThrow(/release.yml has no release-assets job/);
  });

  it("requires real artifact entries rather than directory markers", () => {
    const root = fixture();
    const complete = ["bin/aimux", "package.json", "dist-ui/index.html", "scripts/runtime.sh"];
    expect(verifyRuntimePackagePaths(root, complete)).toEqual([]);
    expect(verifyRuntimePackagePaths(root, ["bin/", "package.json", "scripts/"])).toEqual([
      "runtime package is missing: bin/aimux",
      "runtime package is missing: dist-ui/index.html",
      "runtime package is missing: scripts/runtime.sh",
    ]);
    expect(
      verifyRuntimePackagePaths(
        root,
        complete.filter((path) => path !== "package.json"),
      ),
    ).toEqual(["runtime package is missing: package.json"]);
  });

  it("detects omitted maintained and transitive scripts in actual package paths", () => {
    const root = fixture();
    packageFiles(root, ["bin", "scripts/runtime.sh", "scripts/install-sweep.sh", ...RUNTIME_FILES]);
    write(root, "scripts/install-sweep.sh", 'bash "$REPO/scripts/sweep.sh"\n');
    write(root, "scripts/sweep.sh", "#!/bin/sh\n");
    expect(
      verifyRuntimePackagePaths(root, ["bin/aimux", "package.json", "dist-ui/index.html", "scripts/runtime.sh"]),
    ).toEqual(["runtime package is missing: scripts/install-sweep.sh", "runtime package is missing: scripts/sweep.sh"]);
  });

  it("rejects malformed manifest input and resources outside the package root", () => {
    const root = fixture();
    write(root, "package.json", '{"files": null}');
    expect(() => discoverRuntimeScripts(root)).toThrow(/files must be an array/);
    packageFiles(root, ["../outside.sh"]);
    expect(() => discoverRuntimeScripts(root)).toThrow(/escapes package root/);
  });

  it("requires UI manifest coverage without requiring a built UI in the checkout", () => {
    const root = fixture();
    expect(auditRuntimeManifest(root)).toEqual([]);
    const files = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).files;
    packageFiles(
      root,
      files.filter((path) => path !== "dist-ui"),
    );
    expect(auditRuntimeManifest(root)).toEqual(["package.json files does not cover runtime UI: dist-ui/index.html"]);
    packageFiles(root, ["dist-ui/index.html", ...files.filter((path) => path !== "dist-ui")]);
    expect(auditRuntimeManifest(root)).toEqual([]);
  });

  it("rejects an actual package missing the UI entry point and accepts its restoration", () => {
    const root = fixture();
    const paths = ["bin/aimux", "package.json", "scripts/runtime.sh"];
    expect(verifyRuntimePackagePaths(root, paths)).toEqual(["runtime package is missing: dist-ui/index.html"]);
    expect(verifyRuntimePackagePaths(root, [...paths, "dist-ui/index.html"])).toEqual([]);
  });
});
