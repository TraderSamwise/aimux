import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  auditRuntimeManifest,
  discoverRuntimeScripts,
  verifyRuntimePackagePaths,
  verifyReleaseArchive,
} from "./audit-runtime-package.mjs";

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

  it.each(["node_modules", "target", "tests"])("discovers maintained scripts inside a %s directory", (directory) => {
    const root = fixture();
    packageFiles(root, ["bin", "scripts", ...RUNTIME_FILES]);
    const script = `scripts/${directory}/runtime.sh`;
    write(root, script, "#!/bin/sh\necho maintained\n");
    expect(discoverRuntimeScripts(root)).toContain(script);
  });

  it("excludes dependency, build and test trees only when discovering production Rust callers", () => {
    const root = fixture();
    for (const directory of ["node_modules", "target", "tests"])
      write(root, `native/${directory}/src/proof.rs`, 'fn proof() { run("unshipped.sh"); }');
    expect(discoverRuntimeScripts(root)).toEqual(new Set(["scripts/runtime.sh"]));
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

function releaseArchive(root, { profile = "minimal", omit = [], overrides = {}, modes = {}, extra = [] } = {}) {
  const paths = ["bin/aimux", "package.json", "scripts/runtime.sh", ...extra];
  const files = paths
    .filter((path) => !omit.includes(path))
    .map((path) => ({
      name: `aimux/${path}`,
      data: Buffer.from(overrides[path] ?? readFileSync(join(root, path))).toString("base64"),
      mode: modes[path] ?? 0o755,
    }));
  if (!omit.includes("PACKAGE_PROFILE"))
    files.push({ name: "aimux/PACKAGE_PROFILE", data: Buffer.from(`${profile}\n`).toString("base64"), mode: 0o644 });
  const archive = join(root, "release.tar.gz");
  const result = spawnSync(
    "python3",
    [
      "-c",
      `
import base64, io, json, sys, tarfile
with tarfile.open(sys.argv[1], 'w:gz') as archive:
    for item in json.load(sys.stdin):
        member = tarfile.TarInfo(item['name'])
        member.mode = item['mode']
        data = base64.b64decode(item['data'])
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
`,
      archive,
    ],
    { input: JSON.stringify(files), encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return archive;
}

describe("standalone release runtime closure", () => {
  it("rejects a future runtime helper omitted from the tar even when its manifest entry exists", () => {
    const root = fixture();
    const files = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).files;
    packageFiles(root, [...files, "scripts/future.sh"]);
    write(root, SOURCE, 'fn launch() { resolve_repo_script_path("scripts/future.sh"); }');
    write(root, "scripts/future.sh", "#!/bin/sh\necho future\n");
    expect(auditRuntimeManifest(root)).toEqual([]);
    expect(() => verifyReleaseArchive(root, releaseArchive(root))).toThrow(
      "release archive is missing regular runtime payload: scripts/future.sh",
    );
    expect(verifyReleaseArchive(root, releaseArchive(root, { extra: ["scripts/future.sh"] }))).toContain(
      "scripts/future.sh",
    );
  });

  it("checks a transitive helper from the same discovery closure", () => {
    const root = fixture();
    write(root, "scripts/runtime.sh", '#!/bin/sh\nsh "$script_dir/transitive.sh"\n');
    write(root, "scripts/transitive.sh", "#!/bin/sh\necho dependency\n");
    expect(() => verifyReleaseArchive(root, releaseArchive(root))).toThrow("scripts/transitive.sh");
    expect(verifyReleaseArchive(root, releaseArchive(root, { extra: ["scripts/transitive.sh"] }))).toContain(
      "scripts/transitive.sh",
    );
  });

  it("rejects stale script bytes and lost executable permission", () => {
    const root = fixture();
    chmodSync(join(root, "scripts/runtime.sh"), 0o755);
    expect(() =>
      verifyReleaseArchive(root, releaseArchive(root, { overrides: { "scripts/runtime.sh": "stale" } })),
    ).toThrow("release archive differs from runtime source: scripts/runtime.sh");
    expect(() => verifyReleaseArchive(root, releaseArchive(root, { modes: { "scripts/runtime.sh": 0o644 } }))).toThrow(
      "release archive lost executable permission: scripts/runtime.sh",
    );
    expect(verifyReleaseArchive(root, releaseArchive(root))).toContain("scripts/runtime.sh");
  });

  it("requires full UI contents and accepts a genuinely minimal package without UI", () => {
    const root = fixture();
    write(root, "dist-ui/index.html", '<script src="assets/app.js"></script>');
    write(root, "dist-ui/assets/app.js", "console.log('runtime');\n");
    write(root, "dist-ui/assets/app.js.map", "debug-only\n");
    expect(verifyReleaseArchive(root, releaseArchive(root))).not.toContain("dist-ui/index.html");
    expect(() => verifyReleaseArchive(root, releaseArchive(root, { profile: "full" }))).toThrow("dist-ui/index.html");
    expect(() =>
      verifyReleaseArchive(root, releaseArchive(root, { profile: "full", extra: ["dist-ui/index.html"] })),
    ).toThrow("dist-ui/assets/app.js");
    const complete = { profile: "full", extra: ["dist-ui/index.html", "dist-ui/assets/app.js"] };
    expect(verifyReleaseArchive(root, releaseArchive(root, complete))).toContain("dist-ui/assets/app.js");
    expect(() =>
      verifyReleaseArchive(
        root,
        releaseArchive(root, { ...complete, overrides: { "dist-ui/assets/app.js": "stale" } }),
      ),
    ).toThrow("release archive differs from runtime source: dist-ui/assets/app.js");
  });

  it.each(["node_modules/@expo/font.ttf", "target/generated.bin", "tests/font.woff"])(
    "checks emitted full UI resource inside %s and accepts its restoration",
    (relative) => {
      const root = fixture();
      const resource = `dist-ui/assets/${relative}`;
      write(root, "dist-ui/index.html", "<!doctype html>runtime\n");
      write(root, resource, "emitted resource bytes\n");
      const partial = { profile: "full", extra: ["dist-ui/index.html"] };
      expect(() => verifyReleaseArchive(root, releaseArchive(root, partial))).toThrow(
        `release archive is missing regular runtime payload: ${resource}`,
      );
      expect(
        verifyReleaseArchive(root, releaseArchive(root, { ...partial, extra: [...partial.extra, resource] })),
      ).toContain(resource);
      expect(verifyReleaseArchive(root, releaseArchive(root))).not.toContain(resource);
    },
  );

  it.each(["missing", "invalid"])("refuses %s package profile instead of skipping UI checks", (kind) => {
    const root = fixture();
    const options = kind === "missing" ? { omit: ["PACKAGE_PROFILE"] } : { profile: "local" };
    expect(() => verifyReleaseArchive(root, releaseArchive(root, options))).toThrow(
      "requires regular PACKAGE_PROFILE containing full or minimal",
    );
  });

  it("rejects unsafe archive names and corrupted gzip trailers", () => {
    const root = fixture();
    expect(() =>
      verifyReleaseArchive(root, releaseArchive(root, { extra: ["../unsafe"], overrides: { "../unsafe": "payload" } })),
    ).toThrow("unsafe release archive path");
    const archive = releaseArchive(root);
    const bytes = readFileSync(archive);
    writeFileSync(archive, bytes.subarray(0, bytes.length - 4));
    expect(() => verifyReleaseArchive(root, archive)).toThrow("Compressed file ended");
  });

  it("reports archive read failures and exposes the builder's CLI entry point", () => {
    const root = fixture();
    expect(() => verifyReleaseArchive(root, join(root, "missing.tar.gz"))).toThrow("cannot inspect release archive");
    const archive = releaseArchive(root);
    copyFileSync(join(ROOT, "scripts/audit-runtime-package.mjs"), join(root, "scripts/audit-runtime-package.mjs"));
    const result = spawnSync(
      process.execPath,
      [realpathSync(join(root, "scripts/audit-runtime-package.mjs")), "--release-archive", archive],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("release runtime archive audit passed");
  });
});
