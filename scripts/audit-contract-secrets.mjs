#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { REDACTED_CONTRACT_VALUE, isCredentialName, isCredentialValue } from "./contract-fixture-redaction.mjs";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const CONTRACT_ROOT = join(ROOT, "testdata/contracts/v1");
const failures = [];

function jsonFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return jsonFiles(path);
    if (entry.isFile() && entry.name.endsWith(".json")) return [path];
    return [];
  });
}

function addFailure(file, path, reason) {
  failures.push({ file: relative(ROOT, file), path: path.join("."), reason });
}

function scanValue(file, value, path = []) {
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanValue(file, item, path.concat(String(index))));
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && isCredentialName(key) && isCredentialValue(child)) {
      addFailure(file, path.concat(key), "credential-named field contains a credential-shaped value");
    }
    if (path.at(-1)?.toLowerCase().endsWith("env") && typeof child === "string" && isCredentialValue(child)) {
      addFailure(file, path.concat(key), "env-like map contains a credential-shaped value");
    }
    scanValue(file, child, path.concat(key));
  }
}

function scanCapturedEnvCalls(file, value) {
  const visit = (node, path = []) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, path.concat(String(index))));
      return;
    }
    if (!node || typeof node !== "object") return;

    if (
      node.method === "isInsideTmux" &&
      Array.isArray(node.args) &&
      node.args[0] &&
      typeof node.args[0] === "object" &&
      !Array.isArray(node.args[0])
    ) {
      for (const [key, child] of Object.entries(node.args[0])) {
        if (typeof child === "string" && child !== REDACTED_CONTRACT_VALUE) {
          addFailure(file, path.concat("args", "0", key), "captured environment value is not redacted");
        }
      }
    }

    for (const [key, child] of Object.entries(node)) {
      visit(child, path.concat(key));
    }
  };
  visit(value);
}

for (const file of jsonFiles(CONTRACT_ROOT)) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    failures.push({ file: relative(ROOT, file), path: "", reason: `invalid JSON: ${error.message}` });
    continue;
  }
  scanValue(file, parsed);
  scanCapturedEnvCalls(file, parsed);
}

if (failures.length > 0) {
  console.error(
    JSON.stringify(
      {
        failures: failures.length,
        entries: failures,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

console.log("contract fixture secret audit passed");
