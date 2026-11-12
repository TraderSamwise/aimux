#!/usr/bin/env node
// A refusal reason is a wire value. Rust decides it, the app switches on it,
// and nothing held the two spellings together: this PR removed
// "watched-agent-must-be-coder" and added two more, and every test stayed
// green while the app's typed `reason` named a value the service could no
// longer send.
//
// So each Rust `fn reason(&self) -> &'static str` that answers a refusal is
// paired with the TypeScript union it is served as, and the two sets must
// match exactly. A new variant that nobody adds to the contract fails here,
// and so does a union carrying a reason the service cannot produce.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Each pair names the Rust enum whose `reason()` arms are the source, and the
// TypeScript union that must carry exactly the same strings.
const PAIRS = [
  {
    rustFile: "native/crates/aimux/src/project_service/agent_roles.rs",
    rustEnum: "WatchBindingError",
    tsFile: "src/project-api-contract.ts",
    tsType: "AgentWatchRefusalReason",
    // Served by the route rather than the enum: the body is rejected before
    // a `WatchBindingError` can exist.
    tsOnly: ["invalid-request", "lifecycle-mutation-unavailable"],
  },
  {
    rustFile: "native/crates/aimux/src/project_service/agent_roles.rs",
    rustEnum: "SupervisorRoleError",
    tsFile: "src/project-api-contract.ts",
    tsType: "AgentRoleMutationRefusalReason",
    tsOnly: [],
  },
];

function reasonsFromRust(source, enumName) {
  // The `reason` method inside `impl <enumName>`, and the string literals its
  // match arms answer with.
  const implAt = source.indexOf(`impl ${enumName} {`);
  if (implAt === -1) throw new Error(`no impl block for ${enumName}`);
  const nextImpl = source.indexOf("\nimpl ", implAt + 1);
  const block = source.slice(implAt, nextImpl === -1 ? source.length : nextImpl);
  const reasonAt = block.indexOf("pub fn reason(");
  if (reasonAt === -1) throw new Error(`no reason() in impl ${enumName}`);
  const body = block.slice(reasonAt, block.indexOf("\n    }\n", reasonAt));
  const found = [...body.matchAll(/=>\s*"([a-z0-9-]+)"/g)].map((match) => match[1]);
  if (found.length === 0) throw new Error(`reason() in ${enumName} answered nothing`);
  // Every arm must answer with a literal the line above can see. A reason
  // returned through a const or a helper is invisible to this gate, so it is
  // refused rather than quietly skipped -- a gate that cannot read its own
  // source is not checking anything.
  const arms = [...body.matchAll(/=>/g)].length;
  if (arms !== found.length) {
    throw new Error(
      `reason() in ${enumName} has ${arms} arm(s) but ${found.length} string literal(s); ` +
        `every arm must answer with an inline "kebab-case" literal so this gate can read it`,
    );
  }
  return new Set(found);
}

function reasonsFromTypeScript(source, typeName) {
  const declaration = `export type ${typeName} =`;
  const at = source.indexOf(declaration);
  if (at === -1) throw new Error(`no type ${typeName}`);
  const body = source.slice(at, source.indexOf(";", at));
  const found = [...body.matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1]);
  if (found.length === 0) throw new Error(`type ${typeName} listed nothing`);
  return new Set(found);
}

let failures = 0;
for (const pair of PAIRS) {
  const rust = reasonsFromRust(
    readFileSync(resolve(repoRoot, pair.rustFile), "utf8"),
    pair.rustEnum,
  );
  const ts = reasonsFromTypeScript(
    readFileSync(resolve(repoRoot, pair.tsFile), "utf8"),
    pair.tsType,
  );
  // Deleting unconditionally let a `tsOnly` entry vanish from the union
  // without the gate noticing, which is the same drift in the other
  // direction: the route still sends it and the app no longer types it.
  for (const allowed of pair.tsOnly) {
    if (!ts.delete(allowed)) {
      failures += 1;
      console.error(
        `${pair.tsType} no longer lists "${allowed}", which the route can still send. ` +
          `Remove it from tsOnly as well, or put it back.`,
      );
    }
  }

  const missingFromTs = [...rust].filter((reason) => !ts.has(reason)).sort();
  const missingFromRust = [...ts].filter((reason) => !rust.has(reason)).sort();

  if (missingFromTs.length > 0) {
    failures += 1;
    console.error(
      `${pair.rustEnum} can answer ${missingFromTs.map((r) => `"${r}"`).join(", ")}, ` +
        `which ${pair.tsType} in ${pair.tsFile} does not list.`,
    );
  }
  if (missingFromRust.length > 0) {
    failures += 1;
    console.error(
      `${pair.tsType} lists ${missingFromRust.map((r) => `"${r}"`).join(", ")}, ` +
        `which ${pair.rustEnum} cannot answer. Remove it, or add it to tsOnly with a reason.`,
    );
  }
}

if (failures > 0) {
  console.error("refusal reason parity audit failed");
  process.exit(1);
}

console.log(`refusal reason parity audit passed: ${PAIRS.length} union(s) checked`);
