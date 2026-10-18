import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { discoverRuntimeScripts } from "./audit-runtime-package.mjs";
import { fullPlatforms, verifyNpmPackage } from "./verify-npm-package.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPORARIES = [];
const RUNTIME_SCRIPTS = [
  "scripts/tmux-control.sh",
  "scripts/tmux-open-hyperlink.sh",
  "scripts/cargo-sweep-stale-targets.sh",
  "scripts/install-cargo-sweep-schedule.sh",
];
const SUPPORT = [
  "scripts/release-asset-matrix.py",
  "scripts/verify-linux-binary.py",
  "scripts/audit-runtime-package.mjs",
  "scripts/verify-npm-package.mjs",
  ".github/workflows/release.yml",
];

function write(root, path, content, mode = 0o644) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, { mode });
  chmodSync(join(root, path), mode);
}

function copy(root, path) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  copyFileSync(join(ROOT, path), join(root, path));
}

function sourceFiles(path) {
  return readdirSync(join(ROOT, path), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(child) : [child];
  });
}

function staticElf(arch) {
  const machine = { x64: 62, arm64: 183 }[arch];
  if (!machine) throw new Error(`fixture needs machine code for ${arch}`);
  const code =
    arch === "x64" ? Buffer.from("b83c00000031ff0f05", "hex") : Buffer.from("000080d2a80b80d2010000d4", "hex");
  const data = Buffer.alloc(120 + code.length);
  data.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  data.writeUInt16LE(2, 16);
  data.writeUInt16LE(machine, 18);
  data.writeUInt32LE(1, 20);
  data.writeBigUInt64LE(0x10078n, 24);
  data.writeBigUInt64LE(64n, 32);
  data.writeUInt16LE(64, 52);
  data.writeUInt16LE(56, 54);
  data.writeUInt16LE(1, 56);
  data.writeUInt32LE(1, 64);
  data.writeUInt32LE(5, 68);
  data.writeBigUInt64LE(0x10000n, 80);
  data.writeBigUInt64LE(BigInt(data.length), 96);
  data.writeBigUInt64LE(BigInt(data.length), 104);
  data.writeBigUInt64LE(0x1000n, 112);
  code.copy(data, 120);
  return data;
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aimux-npm-package-")));
  TEMPORARIES.push(root);
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  write(root, "package.json", JSON.stringify(manifest));
  for (const path of ["bin/aimux", "README.md", "LICENSE", ...RUNTIME_SCRIPTS, ...SUPPORT]) copy(root, path);
  for (const path of sourceFiles("native/crates/aimux/src")) {
    if (path.endsWith(".rs") && /scripts\/|\.sh"|dist-ui/.test(readFileSync(join(ROOT, path), "utf8")))
      copy(root, path);
  }
  write(root, "dist-ui/index.html", '<html><script src="/assets/app.js"></script></html>\n');
  write(root, "dist-ui/assets/app.js", "globalThis.aimuxFixture = true;\n");
  write(root, "docs/fixture.md", "Packaged runtime documentation.\n");
  for (const { platform, arch, binary } of fullPlatforms(root)) {
    write(root, binary, platform === "linux" ? staticElf(arch) : "#!/bin/sh\nexit 0\n", 0o755);
    if (platform === "darwin") {
      const bundle = `${dirname(binary)}/aimux-notifier.app/Contents`;
      write(root, `${bundle}/MacOS/aimux-notifier`, "#!/bin/sh\nexit 0\n", 0o755);
      write(
        root,
        `${bundle}/Info.plist`,
        "<plist><dict><key>CFBundleIdentifier</key><string>app.aimux.fixture</string></dict></plist>\n",
      );
      write(root, `${bundle}/Resources/Aimux.icns`, "fixture-icon");
      write(root, `${bundle}/_CodeSignature/CodeResources`, "fixture-signature");
    }
  }
  return root;
}

function environment(root, extra = {}) {
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
  delete env.AIMUX_ROOT;
  delete env.AIMUX_NATIVE_BIN;
  return {
    ...env,
    npm_config_cache: join(root, "npm-cache"),
    npm_config_userconfig: join(root, "empty-npmrc"),
    npm_config_update_notifier: "false",
    ...extra,
  };
}

function run(root, command, args, extra = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment(root, extra),
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

function pack(root) {
  const result = run(root, "npm", ["pack", "--ignore-scripts", "--offline", "--json"]);
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report).toHaveLength(1);
  const archive = join(root, report[0].filename);
  expect(existsSync(archive)).toBe(true);
  return archive;
}

function archivePaths(archive) {
  return execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((path) => path.replace(/^package\//, ""));
}

function changeFiles(root, change) {
  const path = join(root, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.files = change(manifest.files);
  writeFileSync(path, JSON.stringify(manifest));
}

function alterArchive(archive, path, change) {
  const output = `${archive}.changed.tgz`;
  execFileSync("python3", [
    "-c",
    String.raw`
import io, sys, tarfile
source, output, target, change = sys.argv[1:]
found = False
with tarfile.open(source, 'r:gz') as incoming, tarfile.open(output, 'w:gz') as outgoing:
    for member in incoming:
        data = incoming.extractfile(member).read() if member.isfile() else None
        if member.name == 'package/' + target:
            found = True
            if change == 'bytes':
                data += b'changed packed bytes'
                member.size = len(data)
            elif change == 'permissions':
                member.mode = 0o644
            else:
                raise ValueError(change)
        outgoing.addfile(member, io.BytesIO(data) if data is not None else None)
if not found:
    sys.exit('mutation target absent from actual npm archive: ' + target)
`,
    archive,
    output,
    path,
    change,
  ]);
  return output;
}

function launcherFixture(root) {
  const archive = pack(root);
  verifyNpmPackage(root, archive);
  mkdirSync(join(root, "unpacked"));
  execFileSync("tar", ["-xzf", archive, "-C", join(root, "unpacked")]);
  const packaged = realpathSync(join(root, "unpacked/package"));
  for (const { platform, arch, binary } of fullPlatforms(root)) {
    write(
      packaged,
      binary,
      `#!/bin/sh\nprintf '%s\\0' '${platform}-${arch}' "$0" "\${AIMUX_ROOT-}" "\${AIMUX_NATIVE_BIN-}" "$@"\n`,
      0o755,
    );
  }
  write(
    root,
    "fake-bin/uname",
    '#!/bin/sh\ncase "$1" in -s) printf "%s\\n" "$FIXTURE_OS";; -m) printf "%s\\n" "$FIXTURE_ARCH";; *) exit 91;; esac\n',
    0o755,
  );
  mkdirSync(join(root, "prefix/bin"), { recursive: true });
  const symlink = join(root, "prefix/bin/aimux");
  symlinkSync(relative(dirname(symlink), join(packaged, "bin/aimux")), symlink);
  return { packaged, symlink };
}

function platformEnvironment(root, platform, arch) {
  return {
    PATH: `${join(root, "fake-bin")}:${dirname(process.execPath)}:${process.env.PATH}`,
    FIXTURE_OS: { linux: "Linux", darwin: "Darwin" }[platform],
    FIXTURE_ARCH: { x64: "x86_64", arm64: "aarch64" }[arch],
  };
}

afterEach(() => {
  for (const root of TEMPORARIES.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the real npm runtime artifact", () => {
  it("packs the complete matrix and runtime payload from the maintained manifest", () => {
    const root = fixture();
    const archive = pack(root);
    const paths = verifyNpmPackage(root, archive);
    expect(new Set(paths)).toEqual(new Set(archivePaths(archive)));
    for (const { platform, binary } of fullPlatforms(root)) {
      expect(paths).toContain(binary);
      if (platform === "darwin") {
        const bundle = `${dirname(binary)}/aimux-notifier.app/Contents`;
        for (const path of [
          "MacOS/aimux-notifier",
          "Info.plist",
          "Resources/Aimux.icns",
          "_CodeSignature/CodeResources",
        ])
          expect(paths).toContain(`${bundle}/${path}`);
      }
    }
    for (const script of discoverRuntimeScripts(root)) expect(paths).toContain(script);
    expect(paths).toContain("dist-ui/index.html");
    expect(paths).toContain("dist-ui/assets/app.js");
    expect(paths).toContain("docs/fixture.md");
  });

  it("rejects actual packages with either Linux platform removed from files", () => {
    for (const target of fullPlatforms(ROOT).filter(({ platform }) => platform === "linux")) {
      const root = fixture();
      changeFiles(root, (files) => files.filter((path) => path !== dirname(target.binary)));
      const archive = pack(root);
      expect(archivePaths(archive)).not.toContain(target.binary);
      expect(() => verifyNpmPackage(root, archive)).toThrow(
        `package.json files does not cover full release binary: ${target.binary}`,
      );
    }
  });

  it("rejects an actual package with a Rust-loaded script omitted from files", () => {
    const root = fixture();
    const script = "scripts/tmux-open-hyperlink.sh";
    changeFiles(root, (files) => files.filter((path) => path !== script));
    const archive = pack(root);
    expect(archivePaths(archive)).not.toContain(script);
    expect(() => verifyNpmPackage(root, archive)).toThrow(
      `package.json files does not cover runtime script: ${script}`,
    );
  });

  it("rejects missing emitted UI assets even when files only lists the index", () => {
    const root = fixture();
    changeFiles(root, (files) => files.map((path) => (path === "dist-ui" ? "dist-ui/index.html" : path)));
    const archive = pack(root);
    expect(archivePaths(archive)).toContain("dist-ui/index.html");
    expect(archivePaths(archive)).not.toContain("dist-ui/assets/app.js");
    expect(() => verifyNpmPackage(root, archive)).toThrow(
      "npm archive is missing staged runtime payload: dist-ui/assets/app.js",
    );
  });

  it.each(["script bytes", "native bytes", "launcher permissions"])(
    "rejects changed %s in the packed artifact",
    (caseName) => {
      const root = fixture();
      const archive = pack(root);
      const path =
        caseName === "native bytes"
          ? fullPlatforms(root).find(({ platform }) => platform === "linux").binary
          : caseName === "script bytes"
            ? "scripts/tmux-control.sh"
            : "bin/aimux";
      const permissions = caseName.endsWith("permissions");
      const changed = alterArchive(archive, path, permissions ? "permissions" : "bytes");
      expect(() => verifyNpmPackage(root, changed)).toThrow(
        `npm archive ${permissions ? "lost executable permission" : "differs from staged runtime payload"}: ${path}`,
      );
      expect(verifyNpmPackage(root, archive)).toContain(path);
    },
  );

  it("rejects source maps in an actual package", () => {
    const root = fixture();
    write(root, "dist-ui/assets/app.js.map", '{"version":3}\n');
    const archive = pack(root);
    expect(archivePaths(archive)).toContain("dist-ui/assets/app.js.map");
    expect(() => verifyNpmPackage(root, archive)).toThrow(
      "npm archive contains retired or debug payload: dist-ui/assets/app.js.map",
    );
  });
});

describe("the extracted npm launcher with marker executables", () => {
  it("selects every packaged platform through a symlink and preserves arguments and package identity", () => {
    const root = fixture();
    const { packaged, symlink } = launcherFixture(root);
    const args = ["two words", "literal $HOME", "quotes'\"", ""];
    for (const { platform, arch, binary } of fullPlatforms(root)) {
      const result = run(root, symlink, args, platformEnvironment(root, platform, arch));
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.split("\0").slice(0, -1)).toEqual([
        `${platform}-${arch}`,
        join(packaged, binary),
        packaged,
        join(packaged, binary),
        ...args,
      ]);
    }
  });

  it("names the platform and all searched paths when the packaged native is missing", () => {
    const root = fixture();
    const { packaged, symlink } = launcherFixture(root);
    for (const { platform, arch, binary } of fullPlatforms(root)) {
      rmSync(join(packaged, binary));
      const result = run(root, symlink, ["--version"], platformEnvironment(root, platform, arch));
      expect(result.status).toBe(127);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`${platform}-${arch}`);
      for (const path of [binary, "native/target/release/aimux", "native/target/debug/aimux"])
        expect(result.stderr).toContain(join(packaged, path));
    }
  });

  it("names the platform and requested path for a non-executable native override", () => {
    const root = fixture();
    const { symlink } = launcherFixture(root);
    const target = fullPlatforms(root).find(({ platform }) => platform === "linux");
    const requested = join(root, "override with spaces");
    writeFileSync(requested, "not executable\n");
    const result = run(root, symlink, ["--version"], {
      ...platformEnvironment(root, target.platform, target.arch),
      AIMUX_NATIVE_BIN: requested,
    });
    expect(result.status).toBe(127);
    expect(result.stderr).toContain(`${target.platform}-${target.arch}`);
    expect(result.stderr).toContain(requested);
  });
});

describe("the actual prepack guard", () => {
  function prepare(root) {
    write(
      root,
      "scripts/run-yarn",
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE_UI_CALLS"\n[ "$#" -eq 1 ] && [ "$1" = build:ui:local ] || exit 92\n',
      0o755,
    );
    write(root, "fake-bin/cargo", '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE_CARGO_CALLS"\nexit 93\n', 0o755);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return () =>
      run(root, "sh", ["-c", manifest.scripts.prepack], {
        PATH: `${join(root, "fake-bin")}:${dirname(process.execPath)}:${process.env.PATH}`,
        FIXTURE_UI_CALLS: join(root, "ui.calls"),
        FIXTURE_CARGO_CALLS: join(root, "cargo.calls"),
      });
  }

  it("accepts the complete staged release set and runs only the UI step", () => {
    const root = fixture();
    const result = prepare(root)();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, "ui.calls"), "utf8")).toBe("build:ui:local\n");
    expect(existsSync(join(root, "cargo.calls"))).toBe(false);
  });

  it("refuses a missing Linux native before the UI step with an actionable cause", () => {
    const root = fixture();
    const invoke = prepare(root);
    const { binary } = fullPlatforms(root).find(({ platform }) => platform === "linux");
    rmSync(join(root, binary));
    const result = invoke();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm requires the complete staged full release set");
    expect(result.stderr).toContain(binary);
    expect(result.stderr).toContain("stage-npm-assets.py");
    expect(existsSync(join(root, "ui.calls"))).toBe(false);
    expect(existsSync(join(root, "cargo.calls"))).toBe(false);
  });
});
