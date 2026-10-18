import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const verifier = fileURLToPath(new URL("./verify-linux-binary.py", import.meta.url));

function fixture({
  arch = "x64",
  pie = false,
  dynamic = false,
  interpreter = false,
  needed = false,
  version,
  section = false,
} = {}) {
  const data = Buffer.alloc(0x500);
  const u16 = (offset, value) => data.writeUInt16LE(value, offset);
  const u32 = (offset, value) => data.writeUInt32LE(value, offset);
  const u64 = (offset, value) => data.writeBigUInt64LE(BigInt(value), offset);
  data.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  u16(16, pie ? 3 : 2);
  u16(18, arch === "x64" ? 62 : 183);
  u32(20, 1);
  u64(32, 64);
  u16(52, 64);
  u16(54, 56);
  u16(56, dynamic || interpreter ? 2 : 1);
  u32(64, 1);
  u64(64 + 16, 0x1000);
  u64(64 + 32, data.length);
  u64(64 + 40, data.length);
  u64(64 + 48, 1);
  if (dynamic || interpreter) {
    u32(120, interpreter ? 3 : 2);
    u64(120 + 8, 0x100);
    u64(120 + 16, 0x1100);
    u64(120 + 32, 0x60);
    u64(120 + 40, 0x60);
    u64(120 + 48, 8);
  }
  if (interpreter) data.write("/lib/ld-linux.so.2\0", 0x100);
  let cursor = 0x100;
  const tag = (kind, value) => {
    u64(cursor, kind);
    u64(cursor + 8, value);
    cursor += 16;
  };
  if (needed) tag(1, 1);
  if (version && dynamic) {
    tag(5, 0x1260);
    tag(10, 0x60);
    tag(0x6ffffffe, 0x1200);
    tag(0x6fffffff, 1);
  }
  if (dynamic) tag(0, 0);
  if (version) {
    u16(0x200, 1);
    u16(0x202, 1);
    u32(0x204, 1);
    u32(0x208, 16);
    u32(0x210 + 8, 16);
    data.write("\0libc.so.6\0", 0x260);
    data.write(`${version}\0`, 0x270);
  }
  if (section) {
    u64(40, 0x300);
    u16(58, 64);
    u16(60, 3);
    u32(0x340 + 4, 3);
    u64(0x340 + 24, 0x260);
    u64(0x340 + 32, 0x60);
    u32(0x380 + 4, 0x6ffffffe);
    u64(0x380 + 24, 0x200);
    u64(0x380 + 32, 32);
    u32(0x380 + 40, 1);
    u32(0x380 + 44, 1);
  }
  return data;
}

function run(data, arch = "x64") {
  const directory = mkdtempSync(join(tmpdir(), "aimux-linux-elf-"));
  const binary = join(directory, "aimux");
  try {
    if (data !== null) writeFileSync(binary, data);
    const result = spawnSync("python3", [verifier, binary, arch], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    return { ...result, binary };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function refuses(data, cause, arch = "x64") {
  const result = run(data, arch);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(result.binary);
  expect(result.stderr).toContain(`(${arch})`);
  expect(result.stderr).toContain(cause);
  expect(result.stderr).not.toContain("Traceback");
}

describe("Linux binary output gate", () => {
  it.each(["x64", "arm64"])("accepts static ELF64 %s and static PIE", (arch) => {
    for (const pie of [false, true]) {
      const result = run(fixture({ arch, pie, dynamic: pie }), arch);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`(${arch})`);
    }
  });

  it("does not confuse an unreferenced GLIBC string with an imported version", () => {
    const data = fixture();
    data.write("GLIBC_2.39", 0x400);
    expect(run(data).status).toBe(0);
  });

  it("allows non-GLIBC version requirements in section and dynamic metadata", () => {
    for (const dynamic of [false, true]) {
      const result = run(fixture({ version: "OTHER_1.0", section: !dynamic, dynamic }));
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it("rejects a loader even without shared libraries or GLIBC version strings", () => {
    refuses(fixture({ interpreter: true }), "PT_INTERP");
  });

  it("rejects a shared library requirement without an interpreter", () => {
    refuses(fixture({ dynamic: true, needed: true }), "DT_NEEDED");
  });

  it.each(["GLIBC_2.39", "GLIBC_PRIVATE"])("rejects imported %s through section metadata", (version) => {
    refuses(fixture({ version, section: true }), `imported GLIBC version ${version}`);
  });

  it("rejects imported GLIBC versions with no section header table", () => {
    refuses(fixture({ version: "GLIBC_2.39", dynamic: true }), "imported GLIBC version GLIBC_2.39");
  });

  it("walks every auxiliary and every version requirement, not only the first", () => {
    const auxiliary = fixture({ version: "OTHER_1.0", section: true });
    auxiliary.writeUInt16LE(2, 0x202);
    auxiliary.writeUInt32LE(16, 0x21c);
    auxiliary.writeUInt32LE(32, 0x228);
    auxiliary.write("GLIBC_2.39\0", 0x280);
    auxiliary.writeBigUInt64LE(48n, 0x380 + 32);
    refuses(auxiliary, "imported GLIBC version GLIBC_2.39");
    const requirement = fixture({ version: "OTHER_1.0", section: true });
    requirement.writeUInt32LE(32, 0x20c);
    requirement.copy(requirement, 0x220, 0x200, 0x220);
    requirement.writeUInt32LE(0, 0x22c);
    requirement.writeUInt32LE(32, 0x238);
    requirement.write("GLIBC_2.39\0", 0x280);
    requirement.writeBigUInt64LE(64n, 0x380 + 32);
    requirement.writeUInt32LE(2, 0x380 + 44);
    refuses(requirement, "imported GLIBC version GLIBC_2.39");
  });

  it("rejects the wrong machine for either requested architecture", () => {
    refuses(fixture(), "wrong ELF machine 62", "arm64");
    refuses(fixture({ arch: "arm64" }), "wrong ELF machine 183");
  });

  it.each([
    ["ELF header", (data) => data.subarray(0, 32)],
    [
      "not an ELF",
      (data) => {
        data[0] = 0;
        return data;
      },
    ],
    [
      "expected ELF64",
      (data) => {
        data[4] = 1;
        return data;
      },
    ],
    [
      "little-endian",
      (data) => {
        data[5] = 2;
        return data;
      },
    ],
    [
      "identification version",
      (data) => {
        data[6] = 0;
        return data;
      },
    ],
    [
      "executable or static PIE",
      (data) => {
        data.writeUInt16LE(1, 16);
        return data;
      },
    ],
    [
      "program header table",
      (data) => {
        data.writeBigUInt64LE(0xffffffffffffffffn, 32);
        return data;
      },
    ],
    [
      "program segment",
      (data) => {
        data.writeBigUInt64LE(0x501n, 64 + 32);
        return data;
      },
    ],
    [
      "exceeds memory size",
      (data) => {
        data.writeBigUInt64LE(0n, 64 + 40);
        return data;
      },
    ],
    [
      "no PT_LOAD",
      (data) => {
        data.writeUInt32LE(0, 64);
        return data;
      },
    ],
  ])("rejects malformed %s", (cause, mutate) => refuses(mutate(fixture()), cause));

  it("rejects missing files with path and requested architecture", () => refuses(null, "No such file", "arm64"));

  it("rejects truncated section tables and section contents", () => {
    const table = fixture({ version: "OTHER_1.0", section: true });
    table.writeBigUInt64LE(0x4c0n, 40);
    refuses(table, "section header table");
    const content = fixture({ version: "OTHER_1.0", section: true });
    content.writeBigUInt64LE(0x501n, 0x340 + 32);
    refuses(content, "section data");
  });

  it.each([
    ["missing linked string table", (data) => data.writeUInt32LE(9, 0x380 + 40)],
    ["version requirement count", (data) => data.writeUInt32LE(3, 0x380 + 44)],
    ["auxiliary offset", (data) => data.writeUInt32LE(1, 0x208)],
    ["truncated section version auxiliary", (data) => data.writeUInt32LE(48, 0x208)],
    ["auxiliary chain", (data) => data.writeUInt16LE(2, 0x202)],
    ["string index", (data) => data.writeUInt32LE(0x60, 0x218)],
    ["unterminated", (data) => data.fill(65, 0x270, 0x2c0)],
    ["version requirement count", (data) => data.writeUInt32LE(16, 0x20c)],
  ])("rejects malformed version metadata: %s", (cause, mutate) => {
    const data = fixture({ version: "OTHER_1.0", section: true });
    mutate(data);
    refuses(data, cause);
  });

  it("rejects malformed dynamic size, missing terminator, and incomplete version metadata", () => {
    const size = fixture({ dynamic: true });
    size.writeBigUInt64LE(17n, 120 + 32);
    refuses(size, "PT_DYNAMIC size");
    const terminator = fixture({ dynamic: true });
    for (let offset = 0x100; offset < 0x160; offset += 16) terminator.writeBigUInt64LE(12n, offset);
    refuses(terminator, "unterminated PT_DYNAMIC");
    const metadata = fixture({ version: "OTHER_1.0", dynamic: true });
    metadata.writeBigUInt64LE(12n, 0x100);
    refuses(metadata, "incomplete dynamic version requirement metadata");
  });

  it("rejects version pointers outside file-backed load segments", () => {
    const data = fixture({ version: "OTHER_1.0", dynamic: true });
    data.writeBigUInt64LE(0x9000n, 0x128);
    refuses(data, "dynamic version requirements has no unique file-backed PT_LOAD mapping");
  });
});
