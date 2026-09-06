#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/metadata-store/store.json", ROOT);

const paths = await import(new URL("dist/paths.js", ROOT));
const metadata = await import(new URL("dist/metadata-store.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const recordCase = (cases, name, api, input, output) => {
  cases.push({
    id: `metadata-store-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/metadata-store.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
};

function gitInit(cwd) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  execFileSync("git", ["init"], { cwd, stdio: "ignore", env });
}

async function withProject(name, fn) {
  const root = mkdtempSync(join(tmpdir(), `aimux-contract-metadata-${name}-`));
  try {
    gitInit(root);
    await paths.initPaths(root);
    return await fn(root, paths.getReadOnlyProjectPathsFor(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function withClock(iso, fn) {
  const RealDate = Date;
  const fixed = new RealDate(iso);
  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length > 0 ? args : [fixed.getTime()]));
    }

    static now() {
      return fixed.getTime();
    }
  }
  globalThis.Date = FixedDate;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

const cases = [];

await withProject("load", async (root, projectPaths) => {
  const inputState = {
    version: 1,
    sessions: {
      malformed: null,
      valid: {
        backendSessionId: "backend-1",
        label: "stale-label",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
  writeFileSync(projectPaths.metadataPath, JSON.stringify(inputState));
  recordCase(
    cases,
    "loads malformed sessions while scrubbing topology-owned fields",
    "loadMetadataState",
    { state: inputState },
    metadata.loadMetadataState(root),
  );
});

await withProject("save", async (root) => {
  const inputState = {
    version: 1,
    sessions: {
      malformed: null,
      valid: {
        backendSessionId: "backend-1",
        label: "stale-label",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
  metadata.saveMetadataState(inputState, root);
  recordCase(
    cases,
    "saves malformed sessions while scrubbing topology-owned fields",
    "saveMetadataState",
    { state: inputState },
    metadata.loadMetadataState(root),
  );
});

await withProject("loop", async (root) => {
  const input = {
    loop: {
      active: true,
      goal: "ship the feature",
      since: "2026-06-13T00:00:00.000Z",
      source: "dashboard",
      updatedBy: "dashboard",
    },
    clearAction: {
      action: "remove",
      at: "2026-06-13T01:00:00.000Z",
      source: "overseer",
      updatedBySessionId: "boss",
    },
  };
  const afterSet = withClock("2026-06-13T00:00:05.000Z", () => {
    metadata.setSessionLoop("worker-1", input.loop, root);
    metadata.setSessionOverseer("boss", true, root);
    const state = metadata.loadMetadataState(root);
    return { state, overseer: metadata.findOverseerSessionId(state) ?? null };
  });
  const afterClear = withClock("2026-06-13T01:00:05.000Z", () => {
    metadata.clearSessionLoop("worker-1", root, input.clearAction);
    metadata.setSessionOverseer("boss", false, root);
    const state = metadata.loadMetadataState(root);
    return { state, overseer: metadata.findOverseerSessionId(state) ?? null };
  });
  recordCase(
    cases,
    "round-trips loop and overseer flags",
    "setSessionLoop/clearSessionLoop/setSessionOverseer",
    input,
    {
      afterSet,
      afterClear,
    },
  );
});

await withProject("noop", async (root, projectPaths) => {
  const input = { sessionId: "worker-1", status: { text: "ready", tone: "info" } };
  const output = withClock("2026-02-03T04:05:06.000Z", () => {
    metadata.updateSessionMetadata(input.sessionId, (current) => ({ ...current, status: input.status }), root);
    const first = readFileSync(projectPaths.metadataPath, "utf-8");
    metadata.updateSessionMetadata(input.sessionId, (current) => ({ ...current, status: input.status }), root);
    return {
      fileUnchanged: readFileSync(projectPaths.metadataPath, "utf-8") === first,
      state: metadata.loadMetadataState(root),
    };
  });
  recordCase(cases, "skips writes for unchanged session metadata payloads", "updateSessionMetadata", input, output);
});

await withProject("overseer", async (root) => {
  const output = withClock("2026-02-03T04:05:06.000Z", () => {
    metadata.setSessionOverseer("boss-1", true, root);
    metadata.setSessionOverseer("boss-2", true, root);
    const state = metadata.loadMetadataState(root);
    return { state, overseer: metadata.findOverseerSessionId(state) ?? null };
  });
  recordCase(
    cases,
    "enforces a single overseer",
    "setSessionOverseer",
    { sequence: ["boss-1=true", "boss-2=true"] },
    output,
  );
});

await withProject("scribe", async (root) => {
  const output = withClock("2026-02-03T04:05:06.000Z", () => {
    metadata.setSessionScribe("scribe-1", true, root);
    metadata.setSessionScribe("scribe-2", true, root);
    const state = metadata.loadMetadataState(root);
    return { state, scribe: metadata.findScribeSessionId(state) ?? null };
  });
  recordCase(
    cases,
    "enforces a single scribe",
    "setSessionScribe",
    { sequence: ["scribe-1=true", "scribe-2=true"] },
    output,
  );
});

await withProject("scribe-clear", async (root) => {
  const output = withClock("2026-02-03T04:05:06.000Z", () => {
    metadata.setSessionScribe("scribe-1", true, root);
    metadata.setSessionScribe("scribe-1", false, root);
    const state = metadata.loadMetadataState(root);
    return { state, scribe: metadata.findScribeSessionId(state) ?? null };
  });
  recordCase(
    cases,
    "records explicit scribe demotion",
    "setSessionScribe",
    { sequence: ["scribe-1=true", "scribe-1=false"] },
    output,
  );
});

await withProject("segment-put", async (root) => {
  const input = {
    sessionId: "s1",
    operations: [
      { line: "bottom", segment: { id: "a", text: "first" } },
      { line: "bottom", segment: { id: "b", text: "other" } },
      { line: "bottom", segment: { id: "a", text: "second" } },
    ],
  };
  const output = withClock("2026-02-03T04:05:06.000Z", () => {
    for (const operation of input.operations) {
      metadata.putStatuslineSegment(input.sessionId, operation.line, operation.segment, root);
    }
    return metadata.loadMetadataState(root);
  });
  recordCase(cases, "puts segment on rail and replaces by id", "putStatuslineSegment", input, output);
});

await withProject("segment-data", async (root) => {
  const data = { anything: [1, { nested: true }], at: "all" };
  const input = { sessionId: "s1", line: "top", segment: { id: "a", text: "x", data } };
  const output = withClock("2026-02-03T04:05:06.000Z", () => {
    metadata.putStatuslineSegment(input.sessionId, input.line, input.segment, root);
    return metadata.loadMetadataState(root);
  });
  recordCase(cases, "carries opaque segment payload verbatim", "putStatuslineSegment", input, output);
});

await withProject("segment-expiry", async (root) => {
  const input = {
    now: "2026-02-03T04:05:06.000Z",
    operations: [
      { line: "bottom", segment: { id: "gone", text: "stale", expiresAt: "2026-02-03T04:04:06.000Z" } },
      { line: "bottom", segment: { id: "here", text: "live", expiresAt: "2026-02-03T04:15:06.000Z" } },
      { line: "bottom", segment: { id: "forever", text: "no ttl" } },
    ],
  };
  const output = withClock(input.now, () => {
    for (const operation of input.operations) {
      metadata.putStatuslineSegment("s1", operation.line, operation.segment, root);
    }
    return metadata.loadMetadataState(root);
  });
  recordCase(cases, "hides expired segments and keeps live ones", "loadMetadataState", input, output);
});

await withProject("segment-empty", async (root) => {
  const input = {
    now: "2026-02-03T04:05:06.000Z",
    segment: { id: "a", text: "x", expiresAt: "2026-02-03T04:05:05.000Z" },
  };
  const output = withClock(input.now, () => {
    metadata.putStatuslineSegment("s1", "top", input.segment, root);
    return metadata.loadMetadataState(root);
  });
  recordCase(cases, "removes rail when every segment expired", "loadMetadataState", input, output);
});

await withProject("segment-malformed-expiry", async (root) => {
  const input = { sessionId: "s1", line: "top", segment: { id: "a", text: "x", expiresAt: "not a date" } };
  const output = withClock("2026-02-03T04:05:06.000Z", () => {
    metadata.putStatuslineSegment(input.sessionId, input.line, input.segment, root);
    return metadata.loadMetadataState(root);
  });
  recordCase(cases, "keeps segment whose expiry is not a date", "loadMetadataState", input, output);
});

await withProject("segment-drop", async (root) => {
  const input = {
    before: [
      { line: "top", segment: { id: "a", text: "t" } },
      { line: "bottom", segment: { id: "a", text: "b" } },
      { line: "bottom", segment: { id: "keep", text: "k" } },
    ],
    drops: [{ id: "a", line: "top" }, { id: "a" }],
  };
  const output = withClock("2026-02-03T04:05:06.000Z", () => {
    for (const operation of input.before) {
      metadata.putStatuslineSegment("s1", operation.line, operation.segment, root);
    }
    metadata.dropStatuslineSegment("s1", "a", "top", root);
    const afterTopOnly = metadata.loadMetadataState(root);
    metadata.dropStatuslineSegment("s1", "a", undefined, root);
    const afterBoth = metadata.loadMetadataState(root);
    return { afterTopOnly, afterBoth };
  });
  recordCase(cases, "drops segment from one rail or both", "dropStatuslineSegment", input, output);
});

const rejectionSegments = [
  { text: "no id" },
  { id: "a", text: "fine" },
  { id: "a", text: "x", expiresAt: "soon" },
  { id: "a", text: "x", data: { big: "x".repeat(metadata.MAX_SEGMENT_DATA_BYTES) } },
  { id: "a", text: "x", data: { small: true } },
  { id: 7, text: "x" },
];
for (const segment of rejectionSegments) {
  recordCase(
    cases,
    `segment rejection for ${JSON.stringify(segment).slice(0, 60)}`,
    "segmentRejection",
    { segment },
    metadata.segmentRejection(segment),
  );
}

recordCase(
  cases,
  "statusline segment ttl constant",
  "MAX_SEGMENT_TTL_SECONDS",
  {},
  {
    MAX_SEGMENT_TTL_SECONDS: metadata.MAX_SEGMENT_TTL_SECONDS,
    soonRejection: metadata.segmentRejection({
      id: "a",
      text: "x",
      expiresAt: new Date(
        Date.parse("2026-02-03T04:05:06.000Z") + metadata.MAX_SEGMENT_TTL_SECONDS * 1000,
      ).toISOString(),
    }),
  },
);

await withProject("malformed-shapes", async (root, projectPaths) => {
  const inputState = {
    version: 1,
    sessions: {
      nullSession: null,
      stringSession: "nonsense",
      railIsAString: { statusline: { top: "x" }, updatedAt: "2026-01-01T00:00:00.000Z" },
      railHoldsNull: { statusline: { top: [null] }, updatedAt: "2026-01-01T00:00:00.000Z" },
      statuslineIsAnArray: { statusline: [], updatedAt: "2026-01-01T00:00:00.000Z" },
      fine: {
        statusline: { top: [{ id: "a", text: "keep" }] },
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
  writeFileSync(projectPaths.metadataPath, JSON.stringify(inputState));
  recordCase(
    cases,
    "survives malformed statusline shapes on read",
    "loadMetadataState",
    { state: inputState },
    metadata.loadMetadataState(root),
  );
});

const contract = {
  version: 1,
  source: "src/metadata-store.ts",
  generatedBy: "scripts/capture-metadata-store-contract.mjs",
  description:
    "Metadata store persistence, authority-field scrubbing, loop/control flags, statusline segment, and malformed-shape contracts captured by running TypeScript.",
  constants: {
    MAX_SEGMENT_DATA_BYTES: metadata.MAX_SEGMENT_DATA_BYTES,
    MAX_SEGMENT_TTL_SECONDS: metadata.MAX_SEGMENT_TTL_SECONDS,
  },
  cases,
};

await writeContractJson(FIXTURE_PATH, contract);
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
