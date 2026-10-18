import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stager = fileURLToPath(new URL("./stage-npm-assets.py", import.meta.url));
const matrix = fileURLToPath(new URL("./release-asset-matrix.py", import.meta.url));
const matrixResult = spawnSync("python3", [matrix], { encoding: "utf8" });
if (matrixResult.status !== 0) throw new Error(matrixResult.stderr);
const entries = matrixResult.stdout
  .trim()
  .split("\n")
  .map((line) => line.split("\t"))
  .filter(([, , variant]) => variant === "full")
  .map(([platform, arch, , asset]) => ({ platform, arch, asset }));

function nativeBinary(platform, arch) {
  if (platform === "darwin") {
    const data = Buffer.alloc(64);
    data.writeUInt32LE(0xfeedfacf, 0);
    data.writeUInt32LE(arch === "arm64" ? 0x100000c : 0x1000007, 4);
    data.writeUInt32LE(2, 12);
    return data;
  }
  const data = Buffer.alloc(128);
  data.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  data.writeUInt16LE(2, 16);
  data.writeUInt16LE(arch === "arm64" ? 183 : 62, 18);
  data.writeUInt32LE(1, 20);
  data.writeBigUInt64LE(64n, 32);
  data.writeUInt16LE(64, 52);
  data.writeUInt16LE(56, 54);
  data.writeUInt16LE(1, 56);
  data.writeUInt32LE(1, 64);
  data.writeBigUInt64LE(0x1000n, 80);
  data.writeBigUInt64LE(BigInt(data.length), 96);
  data.writeBigUInt64LE(BigInt(data.length), 104);
  data.writeBigUInt64LE(1n, 112);
  return data;
}

function file(name, data, mode = 0o644) {
  return { name, data: Buffer.from(data).toString("base64"), mode };
}

const archiveWriter = `
import base64, io, json, pathlib, sys, tarfile
spec = json.load(sys.stdin)
for archive in spec:
    with tarfile.open(archive["path"], "w:gz") as target:
        for item in archive["members"]:
            entry = tarfile.TarInfo(item["name"])
            entry.mode = item.get("mode", 0o644)
            if item.get("type") in ("symlink", "hardlink"):
                entry.type = tarfile.SYMTYPE if item["type"] == "symlink" else tarfile.LNKTYPE
                entry.linkname = item["target"]
                target.addfile(entry)
            else:
                data = base64.b64decode(item["data"])
                entry.size = len(data)
                target.addfile(entry, io.BytesIO(data))
`;

function setup(mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "aimux-stage-npm-"));
  const root = join(directory, "package");
  const release = join(directory, "release");
  mkdirSync(release);
  const archives = entries.map((entry) => {
    const identity = `${entry.platform}-${entry.arch}`;
    const binary = `aimux/native/${identity}/aimux`;
    const members = [
      file(binary, nativeBinary(entry.platform, entry.arch), 0o755),
      file("aimux/BUILD_VARIANT", "full\n"),
      file("aimux/PACKAGE_PROFILE", "full\n"),
      file("aimux/BUILD_PROFILE", "full\n"),
    ];
    if (entry.platform === "darwin") {
      const bundle = "aimux/native/darwin/aimux-notifier.app";
      members.push(
        file(`${bundle}/Contents/Info.plist`, "<plist><dict/></plist>\n"),
        file(`${bundle}/Contents/MacOS/aimux-notifier`, nativeBinary("darwin", entry.arch), 0o755),
        file(`${bundle}/Contents/_CodeSignature/CodeResources`, "signed resource bytes\n"),
        file(`${bundle}/Contents/Resources/icon.txt`, "icon bytes\n"),
        { name: `${bundle}/Contents/Resources/current-icon`, type: "symlink", target: "icon.txt" },
        { name: `${bundle}/Contents/LinkedResources`, type: "symlink", target: "Resources" },
      );
    }
    const staged = join(root, "native", identity);
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, "previous-staged-file"), `previous ${identity}`);
    return { ...entry, path: join(release, `${entry.asset}.tar.gz`), members };
  });
  mutate(archives);
  const result = spawnSync("python3", ["-c", archiveWriter], {
    input: JSON.stringify(archives),
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return { directory, root, release, archives };
}

function invoke(fixture) {
  const result = spawnSync("python3", [stager, fixture.release, "--root", fixture.root], {
    encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  return result;
}

function preservesExisting(fixture, cause) {
  const result = invoke(fixture);
  expect(result.status, result.stdout).toBe(1);
  expect(result.stderr).toContain(cause);
  expect(result.stderr).not.toContain("Traceback");
  for (const { platform, arch } of entries) {
    const identity = `${platform}-${arch}`;
    const staged = join(fixture.root, "native", identity);
    expect(readFileSync(join(staged, "previous-staged-file"), "utf8")).toBe(`previous ${identity}`);
    expect(existsSync(join(staged, "aimux"))).toBe(false);
  }
}

function testFixture(mutate, test) {
  const fixture = setup(mutate);
  try {
    test(fixture);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
}

describe("npm native release staging", () => {
  it("stages every canonical full binary and the complete notifier bundle", () => {
    testFixture(undefined, (fixture) => {
      const result = invoke(fixture);
      expect(result.status, result.stderr).toBe(0);
      for (const { platform, arch } of entries) {
        const staged = join(fixture.root, "native", `${platform}-${arch}`);
        expect(readFileSync(join(staged, "aimux"))).toEqual(nativeBinary(platform, arch));
        expect(lstatSync(join(staged, "aimux")).mode & 0o111).not.toBe(0);
        expect(existsSync(join(staged, "previous-staged-file"))).toBe(false);
        if (platform === "darwin") {
          const contents = join(staged, "aimux-notifier.app", "Contents");
          expect(readFileSync(join(contents, "Info.plist"), "utf8")).toContain("<plist>");
          expect(readFileSync(join(contents, "_CodeSignature", "CodeResources"), "utf8")).toBe(
            "signed resource bytes\n",
          );
          expect(readlinkSync(join(contents, "Resources", "current-icon"))).toBe("icon.txt");
          expect(readFileSync(join(contents, "LinkedResources", "icon.txt"), "utf8")).toBe("icon bytes\n");
          expect(readFileSync(join(contents, "Resources", "current-icon"), "utf8")).toBe("icon bytes\n");
          expect(lstatSync(join(contents, "MacOS", "aimux-notifier")).mode & 0o111).not.toBe(0);
        }
      }
    });
  });

  it.each(["BUILD_VARIANT", "PACKAGE_PROFILE", "BUILD_PROFILE"])("refuses missing %s metadata atomically", (name) => {
    testFixture(
      (archives) => {
        const archive = archives.at(-1);
        archive.members = archive.members.filter((member) => member.name !== `aimux/${name}`);
      },
      (fixture) => preservesExisting(fixture, `missing required metadata aimux/${name}`),
    );
  });

  it("refuses a missing Linux asset before touching any staged platform", () => {
    testFixture(undefined, (fixture) => {
      const linux = fixture.archives.find(({ platform }) => platform === "linux");
      rmSync(linux.path);
      preservesExisting(fixture, linux.path);
    });
  });

  it.each(["BUILD_VARIANT", "PACKAGE_PROFILE", "BUILD_PROFILE"])("refuses wrong %s metadata atomically", (name) => {
    testFixture(
      (archives) => {
        const metadata = archives.at(-1).members.find((member) => member.name === `aimux/${name}`);
        metadata.data = Buffer.from("local\n").toString("base64");
      },
      (fixture) => preservesExisting(fixture, `wrong ${name}`),
    );
  });

  it.each(["missing", "nonexecutable", "empty"])("refuses %s native binary atomically", (kind) => {
    testFixture(
      (archives) => {
        const archive = archives.at(-1);
        const index = archive.members.findIndex(({ name }) => name.endsWith("/aimux"));
        if (kind === "missing") archive.members.splice(index, 1);
        if (kind === "nonexecutable") archive.members[index].mode = 0o644;
        if (kind === "empty") archive.members[index].data = "";
      },
      (fixture) =>
        preservesExisting(
          fixture,
          kind === "missing" ? "missing required file" : kind === "empty" ? "nonempty regular" : "execute permission",
        ),
    );
  });

  it("uses the actual Linux ELF gate and preserves the child diagnostic", () => {
    testFixture(
      (archives) => {
        const binary = archives.find(({ platform }) => platform === "linux").members[0];
        binary.data = Buffer.from("#!/bin/sh\nexit 0\n").toString("base64");
      },
      (fixture) => {
        preservesExisting(fixture, "invalid Linux binary");
        expect(invoke(fixture).stderr).toContain("ELF header outside binary bounds");
      },
    );
  });

  it("refuses an ELF with the wrong target architecture", () => {
    testFixture(
      (archives) => {
        const archive = archives.find(({ platform }) => platform === "linux");
        archive.members[0].data = nativeBinary("linux", archive.arch === "x64" ? "arm64" : "x64").toString("base64");
      },
      (fixture) => preservesExisting(fixture, "wrong ELF machine"),
    );
  });

  it.each(["Info.plist", "aimux-notifier"])("requires notifier %s before staging", (name) => {
    testFixture(
      (archives) => {
        const archive = archives.find(({ platform }) => platform === "darwin");
        archive.members = archive.members.filter((member) => !member.name.endsWith(`/${name}`));
      },
      (fixture) => preservesExisting(fixture, "missing required file"),
    );
  });

  it.each([
    ["escaping", "../../../../../../outside", "escaping symlink"],
    ["outside-bundle", "OUTSIDE_BUNDLE", "leaves bundle"],
    ["absolute", "/tmp/outside", "unsafe symlink"],
    ["dangling", "does-not-exist", "dangling archive symlink"],
    ["cyclic", "current-icon", "cyclic or excessive archive symlink"],
  ])("refuses %s notifier links atomically", (_label, target, cause) => {
    testFixture(
      (archives) => {
        const archive = archives.find(({ platform }) => platform === "darwin");
        archive.members.find(({ type }) => type === "symlink").target =
          target === "OUTSIDE_BUNDLE" ? `../../../../${archive.platform}-${archive.arch}/aimux` : target;
      },
      (fixture) => preservesExisting(fixture, cause),
    );
  });

  it("resolves symlinks before parent traversals when checking bundle containment", () => {
    testFixture(
      (archives) => {
        const archive = archives.find(({ platform }) => platform === "darwin");
        const prefix = "aimux/native/darwin/aimux-notifier.app/Contents";
        archive.members.push({ name: `${prefix}/Resources/shallow`, type: "symlink", target: ".." });
        archive.members.push(
          file(`aimux/native/darwin/aimux-notifier.app/${archive.platform}-${archive.arch}/aimux`, "decoy"),
        );
        archive.members.find(({ name }) => name.endsWith("/current-icon")).target =
          `shallow/../../../${archive.platform}-${archive.arch}/aimux`;
      },
      (fixture) => preservesExisting(fixture, "leaves bundle"),
    );
  });

  it("refuses metadata symlinks instead of ignoring present invalid metadata", () => {
    testFixture(
      (archives) => {
        const archive = archives.at(-1);
        const index = archive.members.findIndex(({ name }) => name === "aimux/BUILD_VARIANT");
        archive.members[index] = { name: "aimux/BUILD_VARIANT", type: "symlink", target: "PACKAGE_PROFILE" };
      },
      (fixture) => preservesExisting(fixture, "metadata must be a regular file"),
    );
  });

  it("validates the compressed trailer even when every tar member is intact", () => {
    testFixture(undefined, (fixture) => {
      const archive = fixture.archives.at(-1).path;
      const bytes = readFileSync(archive);
      writeFileSync(archive, bytes.subarray(0, bytes.length - 4));
      preservesExisting(fixture, archive);
    });
  });

  it("rejects duplicate member names instead of selecting one set of bytes", () => {
    testFixture(
      (archives) => {
        const archive = archives.at(-1);
        archive.members.push(archive.members[0]);
      },
      (fixture) => preservesExisting(fixture, "duplicate archive path"),
    );
  });

  it("refuses hardlinks instead of extracting aliases to unrelated files", () => {
    testFixture(
      (archives) => {
        archives
          .at(-1)
          .members.push({ name: "aimux/unrelated-hardlink", type: "hardlink", target: "aimux/BUILD_VARIANT" });
      },
      (fixture) => preservesExisting(fixture, "hardlinks and special files are refused"),
    );
  });

  it("rejects traversal even in a file not selected for npm", () => {
    testFixture(
      (archives) => {
        archives.at(-1).members.push(file("aimux/docs/../../outside", "unselected bytes"));
      },
      (fixture) => preservesExisting(fixture, "unsafe archive path"),
    );
  });

  it("rejects truncated archive content before staging", () => {
    testFixture(undefined, (fixture) => {
      const archive = fixture.archives.at(-1).path;
      const bytes = readFileSync(archive);
      writeFileSync(archive, bytes.subarray(0, Math.floor(bytes.length / 2)));
      preservesExisting(fixture, "npm native asset staging failed");
    });
  });
});
