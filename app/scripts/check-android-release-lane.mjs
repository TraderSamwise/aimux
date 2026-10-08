#!/usr/bin/env node
// The Android lane is only reachable if three things agree, and each was wrong
// at some point: the tool must resolve `platformProfiles`, `eas.json` must
// declare the profile it names, and the script must suppress `--auto-submit`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => JSON.parse(readFileSync(join(appRoot, path), "utf8"));
const failures = [];

const releaseConfig = read("eas-release.config.json").eas ?? {};
const easJson = read("eas.json");
const pkg = read("package.json");

const androidProfile = releaseConfig.platformProfiles?.testflight?.android;
if (!androidProfile) {
  failures.push("eas-release.config.json declares no platformProfiles.testflight.android");
} else if (!easJson.build?.[androidProfile]) {
  failures.push(`eas.json has no build profile '${androidProfile}'`);
}

const tool = read("node_modules/@tradersamwise/eas-release/package.json").version;
const dist = readFileSync(
  join(appRoot, "node_modules/@tradersamwise/eas-release/dist/eas.js"),
  "utf8",
);
if (!dist.includes("config.platformProfiles?.[target]?.[platform]")) {
  failures.push(
    `@tradersamwise/eas-release ${tool} ignores platformProfiles, so --android would build the iOS profile`,
  );
}

const script = pkg.scripts?.["build:testflight-android"];
if (!script) {
  failures.push("package.json has no build:testflight-android script");
} else {
  if (!script.includes("--android")) failures.push("the Android lane does not pass --android");
  // `distribute` is unset, so the tool cannot suppress auto-submit itself, and
  // eas.json's submit block carries only ios.ascAppId.
  const distributes = Boolean(releaseConfig.distribute?.testflight?.android);
  if (!distributes && !script.includes("--no-auto-submit")) {
    failures.push(
      "the Android lane would pass --auto-submit with no android submit config; " +
        "pass --no-auto-submit or declare distribute.testflight.android",
    );
  }
}

if (failures.length > 0) {
  console.error("Android release lane check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`Android release lane ok: profile '${androidProfile}', eas-release ${tool}`);
