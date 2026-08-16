#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const expected = process.argv[2];
const allowed = new Set(["testflight", "production"]);

if (!allowed.has(expected)) {
  console.error("Usage: check-release-channel.js <testflight|production>");
  process.exit(2);
}

const versionPath = path.join(__dirname, "..", "lib", "version.ts");
const source = fs.readFileSync(versionPath, "utf8");
const match = source.match(/channel:\s*"([^"]+)"/);
const actual = match?.[1];

if (actual !== expected) {
  console.error(
    `Release channel mismatch: app/lib/version.ts is '${actual ?? "unknown"}', but this command targets '${expected}'.`,
  );
  console.error(
    expected === "testflight"
      ? "Run `yarn version:bump-build` or `yarn version:bump-ota` before TestFlight releases."
      : "Run `yarn version:bump-build production` or `yarn version:bump-ota production` before production releases.",
  );
  process.exit(1);
}

console.log(`Release channel check passed: ${actual}`);
