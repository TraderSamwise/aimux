#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const failures = [];

function readRepoFile(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function findBlock(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) {
    failures.push(`${marker} is missing`);
    return null;
  }
  const brace = source.indexOf("{", start);
  if (brace === -1) {
    failures.push(`${marker} has no body`);
    return null;
  }
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          text: source.slice(brace + 1, index),
          start: brace + 1,
        };
      }
    }
  }
  failures.push(`${marker} body is unterminated`);
  return null;
}

function requireBefore(source, relativePath, blockMarker, beforeNeedle, afterNeedle, message) {
  const block = findBlock(source, blockMarker);
  if (!block) return;
  const before = block.text.indexOf(beforeNeedle);
  const after = block.text.indexOf(afterNeedle);
  if (before === -1) {
    failures.push(`${relativePath}: ${blockMarker} does not read ${beforeNeedle}`);
    return;
  }
  if (after === -1) {
    failures.push(`${relativePath}: ${blockMarker} does not have ${afterNeedle} fallback`);
    return;
  }
  if (after < before) {
    failures.push(
      `${relativePath}:${lineOf(source, block.start + after)} ${message}`,
    );
  }
}

const runtimePath = "native/crates/aimux/src/daemon/runtime.rs";
const runtimeSource = readRepoFile(runtimePath);
const textRuntimeImplPattern = /impl (Daemon[A-Za-z0-9]+TextRuntime) for RealDaemonRuntime \{/g;
for (const match of runtimeSource.matchAll(textRuntimeImplPattern)) {
  const traitName = match[1];
  const block = findBlock(runtimeSource, match[0]);
  if (!block || traitName === "DaemonAgentTextRuntime") continue;
  const ensuredCallPattern = /self\.(get|post)_ensured_project_service_json\(/g;
  for (const ensuredMatch of block.text.matchAll(ensuredCallPattern)) {
    failures.push(
      `${runtimePath}:${lineOf(runtimeSource, block.start + ensuredMatch.index)} ${traitName} uses ensured project-service forwarding before the hot endpoint`,
    );
  }
}

const agentTextPath = "native/crates/aimux/src/daemon/text/agents.rs";
const agentTextSource = readRepoFile(agentTextPath);
agentTextSource.split("\n").forEach((line, index) => {
  const isConstructorDefinition =
    line.includes("pub fn ensure()") || line.includes("pub fn ensure_with_timeout(");
  const hasUnconditionalEnsure =
    line.includes("ProjectServicePostOptions::ensure()") ||
    line.includes("ProjectServicePostOptions::ensure_with_timeout(");
  if (hasUnconditionalEnsure && !isConstructorDefinition) {
    failures.push(
      `${agentTextPath}:${index + 1} mutation route requests unconditional project-service ensure; use hot-or-ensure fallback instead`,
    );
  }
});

const hostAgentPath = "native/crates/aimux/src/daemon/text/host_agent.rs";
const hostAgentSource = readRepoFile(hostAgentPath);
requireBefore(
  hostAgentSource,
  hostAgentPath,
  "pub fn resolve_host_agent_stream_text_route",
  "metadata_endpoint(&project_root)",
  "ensure_project(&project_root)",
  "host agent stream ensures before checking the warm metadata endpoint",
);

const metadataPath = "native/crates/aimux/src/daemon/text/metadata.rs";
const metadataSource = readRepoFile(metadataPath);
requireBefore(
  metadataSource,
  metadataPath,
  "pub fn metadata_text_route",
  "metadata_endpoint(&project_root)",
  "ensure_project(&project_root)",
  "metadata endpoint ensures before checking the warm metadata endpoint",
);

const coreCliPath = "native/crates/aimux/src/core_cli.rs";
const coreCliSource = readRepoFile(coreCliPath);
const cliReadOnlyRoutes = [
  {
    pattern: '("host", "status") =>',
    route: "CORE_API_ROUTES.host_status_text",
    label: "host status",
  },
  {
    pattern: '("daemon", "projects") =>',
    route: "CORE_API_ROUTES.daemon_projects_text",
    label: "daemon projects",
  },
  {
    pattern: '("projects", "") | ("projects", "list") =>',
    route: "CORE_API_ROUTES.projects_list_text",
    label: "projects list",
  },
];
for (const route of cliReadOnlyRoutes) {
  const arm = findMatchArm(coreCliSource, route.pattern, coreCliPath);
  if (!arm) continue;
  if (!arm.text.includes("CoreCliAction::TextRoute") || !arm.text.includes(route.route)) {
    failures.push(
      `${coreCliPath}:${lineOf(coreCliSource, arm.start)} ${route.label} uses the core-command path instead of the lazy-ensure text route`,
    );
  }
  if (arm.text.includes("default_call(")) {
    failures.push(
      `${coreCliPath}:${lineOf(coreCliSource, arm.start)} ${route.label} calls default_call, which ensures the daemon before trying the warm route`,
    );
  }
}

if (failures.length > 0) {
  console.error("Hot-path ensure audit failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Hot-path ensure audit passed: warm daemon text routes use hot endpoints before ensure.");

function findMatchArm(source, marker, relativePath) {
  const start = source.indexOf(marker);
  if (start === -1) {
    failures.push(`${relativePath}: ${marker} is missing`);
    return null;
  }
  const next = source.indexOf("\n        (", start + marker.length);
  return {
    text: source.slice(start, next === -1 ? source.length : next),
    start,
  };
}
