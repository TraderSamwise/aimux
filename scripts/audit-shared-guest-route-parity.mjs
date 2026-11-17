#!/usr/bin/env node
// Which routes a shared-chat guest may use is ONE fact implemented TWICE: the
// relay decides it in `relay/src/sharing.ts` before forwarding, and the daemon
// decides it again in `shared_guest_read_route` / `shared_guest_write_route`.
// Nothing held the two together.
//
// AGENTS.md already says what that costs: "a route list that grows without a
// test asserting the second direction is a guest reaching another agent in the
// owner's project". Widen the daemon's list alone and the relay quietly
// refuses a capability the daemon grants; widen the relay's alone and the
// relay forwards a request the daemon then has to refuse -- or, if the
// daemon's own check is ever loosened, does not.
//
// So both lists are read and required to match exactly. A route added to one
// side and not the other fails here, which is the only place that can see it:
// every test on each side passes happily while the two disagree.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const CONTRACT = "native/crates/aimux/src/project_api_contract.rs";
const DAEMON = "native/crates/aimux/src/request_actor.rs";
const RELAY = "relay/src/sharing.ts";

// Matched by shape rather than by equality on BOTH sides, so neither list
// names them and set comparison would report a false difference:
//   - `/plans/<sessionId>` carries its session in the path and is compared to
//     the share by `plan_route_session` / `planRouteSession`.
//   - `/attachments/<id>/content` is matched by regex on the relay side and by
//     `attachment_content_route` on the daemon side.
const SHAPE_MATCHED = ["/plans/", "/attachments/"];

// Numbers the relay and the daemon must agree on, each named in both
// languages. `proxy_project_binding.rs` says what the drift costs in its own
// words: "Changing one without the other does not fail anything loudly -- it
// makes long checkout paths unmatchable between the owner record and this
// lookup, which surfaces as 'this machine is not serving' a project it is
// serving."
const SHARED_CONSTANTS = [
  {
    name: "MAX_PROJECT_ROOT_CHARS",
    rustFile: "native/crates/aimux/src/proxy_project_binding.rs",
    tsFile: RELAY,
    why: "the cap both sides truncate a stored project root to, so the owner record and the daemon's lookup fold to the same key",
  },
];

function read(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

/// `module::NAME` -> "/path", for every `pub const NAME: &str = "..."` in the
/// contract's nested route modules.
function routeConstants(source) {
  const constants = new Map();
  const moduleStack = [];
  let depth = 0;
  for (const line of source.split("\n")) {
    const moduleMatch = line.match(/^\s*pub mod ([a-z_0-9]+)\s*\{/);
    if (moduleMatch) {
      moduleStack.push({ name: moduleMatch[1], depth });
      depth += 1;
      continue;
    }
    const constMatch = line.match(/^\s*pub const ([A-Z_0-9]+): &str = "([^"]+)"/);
    if (constMatch) {
      // The outermost module is `routes`, which the daemon imports as
      // `project_routes`, so it is not part of the reference path.
      const prefix = moduleStack
        .slice(1)
        .map((entry) => entry.name)
        .join("::");
      const key = prefix ? `${prefix}::${constMatch[1]}` : constMatch[1];
      constants.set(key, constMatch[2]);
      continue;
    }
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    depth += opens - closes;
    while (moduleStack.length > 0 && depth <= moduleStack[moduleStack.length - 1].depth) {
      moduleStack.pop();
    }
  }
  return constants;
}

/// The paths a daemon-side allowlist function admits, resolved through the
/// contract constants it names.
function daemonRoutes(source, functionName, constants) {
  const start = source.indexOf(`fn ${functionName}(`);
  if (start === -1) {
    throw new Error(`${DAEMON}: ${functionName} is gone; this audit names it directly`);
  }
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  const body = source.slice(open, end);
  const paths = new Set();
  for (const reference of body.matchAll(/project_routes::([A-Za-z_0-9:]+)/g)) {
    const key = reference[1];
    const path = constants.get(key);
    if (!path) {
      throw new Error(
        `${DAEMON}: ${functionName} names project_routes::${key}, which ${CONTRACT} does not define`,
      );
    }
    paths.add(path);
  }
  if (paths.size === 0) {
    throw new Error(`${DAEMON}: ${functionName} admitted no routes; the parse is wrong, not the code`);
  }
  return paths;
}

/// The literal paths the relay admits for one method inside
/// `isSharedRelayRequestAllowed`.
function relayRoutes(source, method) {
  const start = source.indexOf("export function isSharedRelayRequestAllowed");
  if (start === -1) {
    throw new Error(`${RELAY}: isSharedRelayRequestAllowed is gone; this audit names it directly`);
  }
  const body = source.slice(start);
  const paths = new Set();
  // Each guard is `method === "GET" && ( path === "..." || ... )`; take the
  // literals that follow the method test, up to the block that closes it.
  const guard = new RegExp(`method === "${method}" &&([\\s\\S]*?)\\n  \\) \\{`, "g");
  for (const block of body.matchAll(guard)) {
    for (const literal of block[1].matchAll(/path === "([^"]+)"/g)) {
      paths.add(literal[1]);
    }
  }
  // Single-line guards, e.g. `if (method === "POST" && path === "/x") return true;`
  const inline = new RegExp(`method === "${method}" && path === "([^"]+)"`, "g");
  for (const literal of body.matchAll(inline)) {
    paths.add(literal[1]);
  }
  if (paths.size === 0) {
    throw new Error(`${RELAY}: no ${method} guest routes parsed; the parse is wrong, not the code`);
  }
  return paths;
}

/// A `const NAME: <type> = <number>;` in Rust, or `const NAME = <number>;` in
/// TypeScript. Absent is an error rather than a skip: a renamed constant must
/// fail here, not quietly drop out of the comparison.
function numericConstant(source, name, file) {
  const rust = source.match(new RegExp(`const ${name}\\s*:\\s*[A-Za-z0-9_]+\\s*=\\s*(\\d+)`));
  const ts = source.match(new RegExp(`const ${name}\\s*=\\s*(\\d+)`));
  const match = rust ?? ts;
  if (!match) {
    throw new Error(`${file}: ${name} is not declared as a numeric constant; this audit names it directly`);
  }
  return Number(match[1]);
}

function compareConstants(problems) {
  for (const entry of SHARED_CONSTANTS) {
    const rustValue = numericConstant(read(entry.rustFile), entry.name, entry.rustFile);
    const tsValue = numericConstant(read(entry.tsFile), entry.name, entry.tsFile);
    if (rustValue !== tsValue) {
      problems.push(
        `${entry.name}: ${entry.rustFile} says ${rustValue} and ${entry.tsFile} says ${tsValue} -- ${entry.why}`,
      );
    }
  }
}

function shapeMatched(path) {
  return SHAPE_MATCHED.some((prefix) => path.startsWith(prefix));
}

function compare(label, daemon, relay, problems) {
  const daemonOnly = [...daemon].filter((path) => !relay.has(path) && !shapeMatched(path)).sort();
  const relayOnly = [...relay].filter((path) => !daemon.has(path) && !shapeMatched(path)).sort();
  for (const path of daemonOnly) {
    problems.push(
      `${label}: the daemon allows ${path} but ${RELAY} does not, so the relay refuses a capability the share is meant to carry`,
    );
  }
  for (const path of relayOnly) {
    problems.push(
      `${label}: ${RELAY} forwards ${path} but the daemon's allowlist does not name it, so the guest's request is refused after it has already been relayed`,
    );
  }
}

const constants = routeConstants(read(CONTRACT));
const daemonSource = read(DAEMON);
const relaySource = read(RELAY);

const problems = [];
compare(
  "guest reads",
  daemonRoutes(daemonSource, "shared_guest_read_route", constants),
  relayRoutes(relaySource, "GET"),
  problems,
);
compare(
  "guest writes",
  daemonRoutes(daemonSource, "shared_guest_write_route", constants),
  relayRoutes(relaySource, "POST"),
  problems,
);
compareConstants(problems);

if (problems.length > 0) {
  console.error("the relay and the daemon disagree:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\nWidening what a guest may do means widening BOTH lists. See AGENTS.md, Shared Chats.",
  );
  process.exit(1);
}

console.log(
  "shared-guest route allowlists and shared caps agree across the relay and the daemon",
);
