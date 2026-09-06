#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/expose/preview-cache.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const cacheModule = await import(new URL("dist/expose-preview-cache.js", ROOT));
const { ExposePreviewCache, EXPOSE_PREVIEW_CAPTURE_LINES, getExposePreviewSnapshot, trackExposePreviewItems } = cacheModule;

function item(id, windowId, target = {}) {
  return {
    id,
    target: { sessionName: "aimux-test", windowId, windowIndex: 1, windowName: "codex", ...target },
  };
}

function recordCase(index, name, input, output) {
  return {
    id: `expose-preview-cache-${String(index + 1).padStart(3, "0")}`,
    name,
    source: "src/expose-preview-cache.test.ts",
    api: "ExposePreviewCache",
    input,
    output,
    inputSha256: hash(input),
  };
}

function callRecord(target, options) {
  return { target, options };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const cases = [];

{
  const calls = [];
  const tmux = {
    captureTargetAsync: async (target, options) => {
      calls.push(callRecord(target, options));
      return `output for ${target.windowId}\n`;
    },
  };
  const cache = new ExposePreviewCache({
    projectRoot: "/repo",
    tmux,
    now: () => new Date("2026-07-20T13:00:00.000Z"),
  });
  cache.start();
  try {
    cache.trackItems([item("a", "@1")]);
    await cache.refreshNow();
    cases.push(
      recordCase(
        cases.length,
        "captures tracked targets as preview snapshots",
        { scenario: "capture-tracked", projectRoot: "/repo", items: [item("a", "@1")] },
        { calls, snapshot: cache.get("@1"), missingSnapshot: cache.get("@2") ?? null, captureLines: EXPOSE_PREVIEW_CAPTURE_LINES },
      ),
    );
  } finally {
    cache.stop();
  }
}

{
  const calls = [];
  let fail = false;
  const tmux = {
    captureTargetAsync: async (target, options) => {
      calls.push(callRecord(target, options));
      if (fail) throw new Error("tmux unavailable");
      return "first output\n";
    },
  };
  const cache = new ExposePreviewCache({ projectRoot: "/repo", tmux, now: () => new Date("2026-07-20T13:00:00.000Z") });
  cache.start();
  try {
    cache.trackItems([item("a", "@1")]);
    await cache.refreshNow();
    fail = true;
    await cache.refreshNow();
    cases.push(recordCase(cases.length, "keeps the last good snapshot when capture fails", { scenario: "last-good-on-failure" }, { calls, snapshot: cache.get("@1") }));
  } finally {
    cache.stop();
  }
}

{
  let nowMs = Date.parse("2026-07-20T13:00:00.000Z");
  const calls = [];
  const tmux = {
    captureTargetAsync: async (target, options) => {
      calls.push(callRecord(target, options));
      return `output for ${target.windowId}\n`;
    },
  };
  const cache = new ExposePreviewCache({ projectRoot: "/repo", tmux, activeMs: 1000, now: () => new Date(nowMs) });
  cache.start();
  try {
    cache.trackItems([item("a", "@1")]);
    await cache.refreshNow();
    const firstSnapshot = cache.get("@1");
    calls.length = 0;
    nowMs += 500;
    cache.trackItems([item("b", "@2")]);
    await cache.refreshNow();
    const during = { calls: [...calls], snapshots: { one: cache.get("@1"), two: cache.get("@2") } };
    calls.length = 0;
    nowMs += 600;
    const expired = cache.get("@1") ?? null;
    await cache.refreshNow();
    cases.push(recordCase(cases.length, "captures the active demand union until old demand expires", { scenario: "demand-union-expiry" }, { firstSnapshot, during, expired, finalCalls: calls }));
  } finally {
    cache.stop();
  }
}

{
  const capture = deferred();
  const calls = [];
  const tmux = {
    captureTargetAsync: (target, options) => {
      calls.push(callRecord(target, options));
      return capture.promise;
    },
  };
  const cache = new ExposePreviewCache({ projectRoot: "/repo", tmux, now: () => new Date("2026-07-20T13:00:00.000Z") });
  cache.start();
  try {
    cache.trackItems([item("a", "@1")]);
    const refresh = cache.refreshNow();
    cache.trackItems([item("a-fresh", "@1")]);
    capture.resolve("late output\n");
    await refresh;
    cases.push(recordCase(cases.length, "accepts in-flight captures after identical re-demand", { scenario: "identical-redemand-inflight" }, { calls, snapshot: cache.get("@1") }));
  } finally {
    cache.stop();
  }
}

{
  let nowMs = Date.parse("2026-07-20T13:00:00.000Z");
  const capture = deferred();
  const calls = [];
  const tmux = {
    captureTargetAsync: (target, options) => {
      calls.push(callRecord(target, options));
      return capture.promise;
    },
  };
  const cache = new ExposePreviewCache({ projectRoot: "/repo", tmux, activeMs: 1000, now: () => new Date(nowMs) });
  cache.start();
  try {
    cache.trackItems([item("a", "@1")]);
    const refresh = cache.refreshNow();
    nowMs += 1001;
    cache.trackItems([item("a-renewed", "@1")]);
    capture.resolve("late output\n");
    await refresh;
    cases.push(recordCase(cases.length, "ignores in-flight captures after demand expires and is renewed", { scenario: "expired-redemand-inflight" }, { calls, snapshot: cache.get("@1") ?? null }));
  } finally {
    cache.stop();
  }
}

{
  const calls = [];
  const tmux = {
    captureTargetAsync: async (target, options) => {
      calls.push(callRecord(target, options));
      throw new Error("tmux unavailable");
    },
  };
  const cache = new ExposePreviewCache({ projectRoot: "/repo", tmux, now: () => new Date("2026-07-20T13:00:00.000Z") });
  cache.start();
  try {
    cache.trackItems([item("a", "@1")]);
    await cache.refreshNow();
    await cache.refreshNow();
    await cache.refreshNow();
    await cache.refreshNow();
    cases.push(recordCase(cases.length, "evicts tracked targets after repeated capture failures", { scenario: "repeated-failures-evict" }, { callCount: calls.length, snapshot: cache.get("@1") ?? null, stats: cache.stats() }));
  } finally {
    cache.stop();
  }
}

{
  const cache = new ExposePreviewCache({
    projectRoot: "/repo",
    tmux: { captureTargetAsync: async () => "registered output\n" },
    now: () => new Date("2026-07-20T13:00:00.000Z"),
  });
  cache.start();
  try {
    cache.trackItems([item("a", "@1")]);
    await cache.refreshNow();
    const beforeStop = {
      direct: getExposePreviewSnapshot("/repo", "@1")?.output ?? null,
      normalized: getExposePreviewSnapshot("/repo/../repo", "@1")?.output ?? null,
    };
    cache.stop();
    cases.push(recordCase(cases.length, "registers running caches for daemon global expose responses", { scenario: "global-registry-get" }, { beforeStop, afterStop: getExposePreviewSnapshot("/repo", "@1") ?? null }));
  } finally {
    cache.stop();
  }
}

{
  const calls = [];
  const tmux = {
    captureTargetAsync: async (target, options) => {
      calls.push(callRecord(target, options));
      return `registry output for ${target.windowId}\n`;
    },
  };
  const cache = new ExposePreviewCache({
    projectRoot: "/repo",
    tmux,
    now: () => new Date("2026-07-20T13:00:00.000Z"),
  });
  cache.start();
  try {
    trackExposePreviewItems("/repo/../repo", [item("a", "@1")]);
    await cache.refreshNow();
    cases.push(recordCase(cases.length, "tracks demand through the project registry", { scenario: "global-registry-track" }, { calls, snapshot: cache.get("@1") }));
  } finally {
    cache.stop();
  }
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/expose-preview-cache.test.ts",
  generatedBy: "scripts/capture-expose-preview-cache-contract.mjs",
  description:
    "Expose preview cache tracked-target, snapshot, failure, in-flight, demand-expiry, and global registry behavior captured by running TypeScript ExposePreviewCache with mocked tmux capture.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
