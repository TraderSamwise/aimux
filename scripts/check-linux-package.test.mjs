import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const checker = fileURLToPath(new URL("./check-linux-package.py", import.meta.url));
const scripts = [
  "cargo-sweep-stale-targets.sh",
  "install-cargo-sweep-schedule.sh",
  "tmux-control.sh",
  "tmux-open-hyperlink.sh",
];

function elf(arch, stamp = "fixture-stamp") {
  const data = Buffer.alloc(256);
  data.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  data.writeUInt16LE(2, 16);
  data.writeUInt16LE(arch === "x64" ? 62 : 183, 18);
  data.writeUInt32LE(1, 20);
  data.writeBigUInt64LE(64n, 32);
  data.writeUInt16LE(64, 52);
  data.writeUInt16LE(56, 54);
  data.writeUInt16LE(1, 56);
  data.writeUInt32LE(1, 64);
  data.writeBigUInt64LE(256n, 96);
  data.writeBigUInt64LE(256n, 104);
  data.writeBigUInt64LE(1n, 112);
  data.write(`AIMUX_EMBEDDED_BUILD_STAMP=${stamp}\0`, 128);
  return data;
}

function entries(arch = "x64", variant = "full", profile = "minimal") {
  const files = new Map();
  const add = (name, data, mode = 0o644) =>
    files.set(`aimux/${name}`, { data: Buffer.from(data).toString("base64"), mode });
  add(`native/linux-${arch}/aimux`, elf(arch), 0o755);
  add("bin/aimux", "#!/bin/sh\nexec ignored\n", 0o755);
  for (const name of scripts) add(`scripts/${name}`, "#!/bin/sh\nexit 0\n", 0o755);
  add("package.json", JSON.stringify({ name: "aimux-cli", version: "0.1.70" }));
  add("BUILD_STAMP", "fixture-stamp\n");
  add("BUILD_VARIANT", `${variant}\n`);
  add("PACKAGE_PROFILE", `${profile}\n`);
  return files;
}

function invoke(files, arch = "x64", options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "aimux-package-test-"));
  const archive = join(directory, "release.tar.gz");
  try {
    if (files !== null) {
      const manifest = join(directory, "files.json");
      writeFileSync(manifest, JSON.stringify([...files]));
      const create = spawnSync(
        "python3",
        [
          "-c",
          `
import base64, io, json, sys, tarfile
with tarfile.open(sys.argv[2], "w:gz") as archive:
    for name, entry in json.load(open(sys.argv[1])):
        data = base64.b64decode(entry["data"])
        member = tarfile.TarInfo(name)
        member.mode = entry["mode"]
        member.type = tarfile.SYMTYPE if entry.get("symlink") else tarfile.REGTYPE
        member.linkname = entry.get("symlink", "")
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
`,
          manifest,
          archive,
        ],
        { encoding: "utf8" },
      );
      expect(create.status, create.stderr).toBe(0);
    }
    const args = options.probe
      ? ["-c", options.probe, checker, archive, arch]
      : [checker, archive, arch, ...(options.run ? ["--run"] : [])];
    const result = spawnSync("python3", args, { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    return { ...result, archive };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function refuse(files, cause, arch = "x64", options) {
  const result = invoke(files, arch, options);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(result.archive);
  expect(result.stderr).toContain(`(${arch})`);
  expect(result.stderr).toContain(cause);
  expect(result.stderr).not.toContain("Traceback");
}

function replace(files, name, text) {
  files.get(`aimux/${name}`).data = Buffer.from(text).toString("base64");
}

describe("produced Linux release package gate", () => {
  it.each(["x64", "arm64"])("checks actual %s binary bytes for every valid variant/profile", (arch) => {
    for (const variant of ["full", "local"]) {
      for (const profile of ["full", "minimal"]) {
        const result = invoke(entries(arch, variant, profile), arch);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(`variant=${variant}, profile=${profile}`);
      }
    }
  });

  it.each([
    "bin/aimux",
    "package.json",
    "BUILD_STAMP",
    "BUILD_VARIANT",
    "PACKAGE_PROFILE",
    ...scripts.map((name) => `scripts/${name}`),
  ])("rejects missing runtime file %s", (name) => {
    const files = entries();
    files.delete(`aimux/${name}`);
    refuse(files, `missing regular runtime file aimux/${name}`);
  });

  it("rejects missing selected-architecture binary and wrong ELF machine", () => {
    refuse(entries(), "native/linux-arm64/aimux", "arm64");
    const files = entries("arm64");
    replace(files, "native/linux-arm64/aimux", elf("x64"));
    refuse(files, "wrong ELF machine 62", "arm64");
  });

  it.each(["bin/aimux", "native/linux-x64/aimux", "scripts/tmux-control.sh"])(
    "requires executable mode for %s",
    (name) => {
      const files = entries();
      files.get(`aimux/${name}`).mode = 0o644;
      refuse(files, "not executable");
      files.get(`aimux/${name}`).mode = 0o001;
      refuse(files, "not executable");
    },
  );

  it("rejects a shell stand-in even when its stamp matches", () => {
    const files = entries();
    replace(
      files,
      "native/linux-x64/aimux",
      Buffer.from("#!/bin/sh\n" + " ".repeat(80) + "AIMUX_EMBEDDED_BUILD_STAMP=fixture-stamp\0"),
    );
    refuse(files, "not an ELF binary");
  });

  it("rejects a stamp mismatch and missing embedded witness", () => {
    const mismatch = entries();
    replace(mismatch, "BUILD_STAMP", "other-stamp\n");
    refuse(mismatch, "build stamp mismatch: archive other-stamp, binary ['fixture-stamp']");
    const missing = entries();
    const binary = elf("x64");
    binary.fill(0, 128);
    replace(missing, "native/linux-x64/aimux", binary);
    refuse(missing, "missing embedded build stamp witness");
  });

  it.each([
    ["BUILD_VARIANT", "minimal"],
    ["PACKAGE_PROFILE", "local"],
    ["BUILD_STAMP", "first\nsecond"],
  ])("rejects invalid %s", (name, value) => {
    const files = entries();
    replace(files, name, value);
    refuse(files, `invalid ${name}`);
  });

  it("rejects invalid package JSON and absent archive", () => {
    const files = entries();
    replace(files, "package.json", "{");
    refuse(files, "Expecting property name");
    refuse(null, "No such file");
  });

  it("refuses traversal and required symlinks without extracting them", () => {
    const unsafe = entries();
    unsafe.set("aimux/../../escaped", { data: "eA==", mode: 0o644 });
    refuse(unsafe, "unsafe archive member");
    const symlink = entries();
    symlink.get("aimux/bin/aimux").symlink = "/bin/sh";
    refuse(symlink, "missing regular runtime file aimux/bin/aimux");
  });

  it("runs only --version with isolated home and reports child failure", () => {
    const probe = `
import importlib.util, os, pathlib, subprocess, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("gate", sys.argv[1])
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
gate.platform.system = lambda: "Linux"
gate.platform.machine = lambda: "x86_64"
os.environ["AIMUX_NATIVE_BIN"] = "/wrong/binary"
def run(command, **kwargs):
    assert command[1:] == ["--version"]
    assert pathlib.Path(command[0]).read_bytes().startswith(b"\\x7fELF")
    env = kwargs["env"]
    assert "AIMUX_NATIVE_BIN" not in env
    assert pathlib.Path(env["AIMUX_HOME"], "test-isolation.json").is_file()
    assert pathlib.Path(env["HOME"]).is_dir()
    return subprocess.CompletedProcess(command, 0, "0.1.70\\n", "")
gate.subprocess.run = run
gate.check_package(sys.argv[2], sys.argv[3], True)
gate.subprocess.run = lambda *args, **kwargs: subprocess.CompletedProcess(args, 7, "", "child crash cause")
sys.argv = [sys.argv[1], sys.argv[2], sys.argv[3], "--run"]
sys.exit(gate.main())
`;
    refuse(entries(), "exited 7: stdout='', stderr='child crash cause'", "x64", { probe });
  });

  it("accepts the actual plain version and rejects wrong or prefixed versions", () => {
    const probe = `
import importlib.util, subprocess, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("gate", sys.argv[1])
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
gate.platform.system = lambda: "Linux"
gate.platform.machine = lambda: "x86_64"
gate.subprocess.run = lambda *args, **kwargs: subprocess.CompletedProcess(args, 0, "0.1.70\\n", "")
gate.check_package(sys.argv[2], sys.argv[3], True)
for output in ("0.1.71\\n", "aimux 0.1.70\\n", "garbage 0.1.70\\n", "0.1.70 extra\\n", "0.1.70\\n0.1.70\\n"):
    gate.subprocess.run = lambda *args, **kwargs: subprocess.CompletedProcess(args, 0, output, "")
    try:
        gate.check_package(sys.argv[2], sys.argv[3], True)
    except ValueError as error:
        assert "unexpected output" in str(error)
    else:
        raise AssertionError("accepted invalid version output: " + repr(output))
`;
    const result = invoke(entries(), "x64", { probe });
    expect(result.status, result.stderr).toBe(0);
  });

  it("refuses --run on a mismatched native architecture", () => {
    const arch = process.arch === "arm64" ? "x64" : "arm64";
    refuse(entries(arch), `--run requires native Linux ${arch}`, arch, { run: true });
  });
});
