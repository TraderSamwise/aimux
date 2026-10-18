import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const generator = fileURLToPath(new URL("./generate-cargo-sbom.py", import.meta.url));
const environment = {
  ...process.env,
  CARGO_NET_OFFLINE: "true",
  CARGO_INCREMENTAL: "0",
  CARGO_TARGET_DIR:
    process.env.CARGO_TARGET_DIR || join(tmpdir(), `aimux-cargo-target-${process.env.AIMUX_SESSION_ID || "sbom-fixture"}`),
};
let fixture;

function crate(directory, name, extra = "") {
  mkdirSync(join(directory, "src"), { recursive: true });
  writeFileSync(join(directory, "src/lib.rs"), "pub fn fixture() {}\n");
  writeFileSync(
    join(directory, "Cargo.toml"),
    `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n${extra}`,
  );
}

function generated(platform, variant) {
  const output = join(fixture, `${platform}-${variant}.spdx.json`);
  const result = spawnSync(
    "python3",
    [
      generator,
      "--manifest-path",
      join(fixture, "Cargo.toml"),
      "--platform-arch",
      platform,
      "--variant",
      variant,
      "--asset",
      `aimux-${platform}.tar.gz`,
      "--asset-sha256",
      "a".repeat(64),
      "--source-revision",
      "b".repeat(40),
      "--version",
      "1.2.3",
      "--output",
      output,
    ],
    { cwd: fixture, env: environment, encoding: "utf8", timeout: 30000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(readFileSync(output, "utf8"));
}

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), "aimux-sbom-target-"));
  for (const name of ["common", "feature-only", "musl-only", "gnu-only", "darwin-only"]) {
    crate(join(fixture, name), name);
  }
  crate(
    fixture,
    "fixture-root",
    `
[workspace]
[features]
default = ["feature-only"]
[dependencies]
common = { path = "common" }
feature-only = { path = "feature-only", optional = true }
[target.'cfg(target_env = "musl")'.dependencies]
musl-only = { path = "musl-only" }
[target.'cfg(target_env = "gnu")'.dependencies]
gnu-only = { path = "gnu-only" }
[target.'cfg(target_os = "macos")'.dependencies]
darwin-only = { path = "darwin-only" }
`,
  );
  const lock = spawnSync("cargo", ["generate-lockfile", "--offline", "--manifest-path", join(fixture, "Cargo.toml")], {
    cwd: fixture,
    env: environment,
    encoding: "utf8",
    timeout: 30000,
  });
  expect(lock.error).toBeUndefined();
  expect(lock.status, lock.stderr).toBe(0);
}, 30000);

afterAll(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

describe("release SBOM follows the resolved platform dependency set", () => {
  it.each([
    ["linux-x64", "full"],
    ["linux-x64", "local"],
    ["linux-arm64", "full"],
    ["linux-arm64", "local"],
  ])(
    "produced musl SBOM for %s %s includes musl and excludes GNU",
    (platform, variant) => {
      const document = generated(platform, variant);
      const names = document.packages.map((entry) => entry.name);
      expect(names).toContain("fixture-root");
      expect(names).toContain("common");
      expect(names).toContain("musl-only");
      expect(names).not.toContain("gnu-only");
      expect(names).not.toContain("darwin-only");
      expect(names.includes("feature-only")).toBe(variant === "full");
      expect(document.packages.find((entry) => entry.name === "fixture-root").versionInfo).toBe("1.2.3");
      const root = document.packages.find((entry) => entry.name === "fixture-root").SPDXID;
      const musl = document.packages.find((entry) => entry.name === "musl-only").SPDXID;
      expect(document.relationships).toContainEqual({
        spdxElementId: root,
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: musl,
      });
    },
    30000,
  );

  it.each([
    ["darwin-arm64", "full"],
    ["darwin-arm64", "local"],
    ["darwin-x64", "full"],
    ["darwin-x64", "local"],
  ])(
    "keeps the Darwin inverse dependency set for %s %s",
    (platform, variant) => {
      const names = generated(platform, variant).packages.map((entry) => entry.name);
      expect(names).toContain("common");
      expect(names).toContain("darwin-only");
      expect(names).not.toContain("musl-only");
      expect(names).not.toContain("gnu-only");
      expect(names.includes("feature-only")).toBe(variant === "full");
    },
    30000,
  );
});
