#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/expose/pane-output-tap.json", ROOT);

const { EXPOSE_PANE_TAP_ACTIVE_MS, EXPOSE_PANE_TAP_MAINTENANCE_MS, EXPOSE_PANE_TAP_MAX_BYTES, ExposePaneOutputTap } =
  await import(new URL("dist/expose-pane-output-tap.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function item(id, windowId, target = {}) {
  return {
    id,
    target: { sessionName: "aimux-test", windowId, windowIndex: 1, windowName: "codex", ...target },
  };
}

function tapDir(projectStateDir) {
  return join(projectStateDir, "expose-pane-taps");
}

function tapFiles(projectStateDir, suffix = ".log") {
  const dir = tapDir(projectStateDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(suffix))
    .sort()
    .map((entry) => join(dir, entry));
}

function fileContents(projectStateDir, suffix = ".log") {
  return Object.fromEntries(
    tapFiles(projectStateDir, suffix).map((path) => [basename(path), readFileSync(path, "utf8")]),
  );
}

function markOwned(options) {
  if (options?.ownership) {
    writeFileSync(options.ownership.tokenFilePath, `${process.pid}\t${options.ownership.token}\n`);
  }
}

function normalizeTarget(target) {
  return {
    sessionName: target.sessionName,
    windowId: target.windowId,
    windowIndex: target.windowIndex,
    windowName: target.windowName,
  };
}

function createTmux({ isPanePiped = false, pipeTargetToFile } = {}) {
  const calls = { isPanePiped: [], pipeTargetToFile: [], stopPanePipe: [] };
  const tmux = {
    calls,
    isPanePiped(target) {
      calls.isPanePiped.push(normalizeTarget(target));
      return typeof isPanePiped === "function" ? isPanePiped(target) : isPanePiped;
    },
    pipeTargetToFile(target, filePath, options) {
      calls.pipeTargetToFile.push({
        target: normalizeTarget(target),
        file: basename(filePath),
        onlyIfNotPiped: Boolean(options?.onlyIfNotPiped),
        hasOwnership: Boolean(options?.ownership?.token && options?.ownership?.tokenFilePath),
      });
      if (pipeTargetToFile) return pipeTargetToFile(target, filePath, options);
      markOwned(options);
      writeFileSync(filePath, `output for ${target.windowId}\n`);
    },
    stopPanePipe(target) {
      calls.stopPanePipe.push(normalizeTarget(target));
    },
  };
  return tmux;
}

function withTempProject(fn) {
  const projectStateDir = mkdtempSync(join(tmpdir(), "aimux-contract-expose-tap-"));
  try {
    return fn(projectStateDir);
  } finally {
    rmSync(projectStateDir, { recursive: true, force: true });
  }
}

const cases = [];
const recordCase = (name, input, output) => {
  cases.push({
    id: `expose-pane-output-tap-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/expose-pane-output-tap.ts",
    api: "ExposePaneOutputTap",
    input,
    output,
    inputSha256: hash(input),
  });
};

recordCase(
  "starts tmux pipe and reads latest tap output",
  { items: [item("a", "@1")], now: "2026-07-20T13:00:00.000Z" },
  withTempProject((projectStateDir) => {
    const tmux = createTmux();
    const tap = new ExposePaneOutputTap({
      projectStateDir,
      tmux,
      now: () => new Date("2026-07-20T13:00:00.000Z"),
    });
    tap.start();
    tap.trackItems([item("a", "@1")]);
    const snapshot = tap.read("@1");
    const filesBeforeStop = tapFiles(projectStateDir).map((path) => basename(path));
    tap.stop();
    return { snapshot, filesBeforeStop, filesAfterStop: tapFiles(projectStateDir).length, calls: tmux.calls };
  }),
);

recordCase(
  "does not restart already tracked target while demand is renewed",
  { activeMs: 1000, renewAfterMs: 500 },
  withTempProject((projectStateDir) => {
    let nowMs = Date.parse("2026-07-20T13:00:00.000Z");
    const tmux = createTmux();
    const tap = new ExposePaneOutputTap({ projectStateDir, tmux, activeMs: 1000, now: () => new Date(nowMs) });
    tap.start();
    tap.trackItems([item("a", "@1")]);
    nowMs += 500;
    tap.trackItems([item("a-fresh", "@1")]);
    const output = {
      pipeCalls: tmux.calls.pipeTargetToFile.length,
      stopCalls: tmux.calls.stopPanePipe.length,
      readOutput: tap.read("@1")?.output ?? null,
      stats: tap.stats(),
    };
    tap.stop();
    return output;
  }),
);

recordCase(
  "skips panes already piped so stop only detaches owned taps",
  { isPanePiped: true },
  withTempProject((projectStateDir) => {
    const tmux = createTmux({ isPanePiped: true });
    const tap = new ExposePaneOutputTap({ projectStateDir, tmux });
    tap.start();
    tap.trackItems([item("a", "@1")]);
    tap.stop();
    return {
      pipeCalls: tmux.calls.pipeTargetToFile.length,
      stopCalls: tmux.calls.stopPanePipe.length,
      read: tap.read("@1") ?? null,
      filesAfterStop: tapFiles(projectStateDir).length,
    };
  }),
);

recordCase(
  "adopts live owned tap after manager restart",
  { windowId: "@1" },
  withTempProject((projectStateDir) => {
    const initialTmux = createTmux({
      pipeTargetToFile: (_target, filePath, options) => {
        markOwned(options);
        writeFileSync(filePath, "warm tap output\n");
      },
    });
    const initialTap = new ExposePaneOutputTap({ projectStateDir, tmux: initialTmux });
    initialTap.start();
    initialTap.trackItems([item("a", "@1")]);

    const restartedTmux = createTmux({ isPanePiped: true });
    const restartedTap = new ExposePaneOutputTap({ projectStateDir, tmux: restartedTmux });
    restartedTap.start();
    restartedTap.trackItems([item("a-restarted", "@1")]);
    const readOutput = restartedTap.read("@1")?.output ?? null;
    restartedTap.stop();
    initialTap.stop();
    return {
      readOutput,
      restartedCalls: restartedTmux.calls,
      initialStopCalls: initialTmux.calls.stopPanePipe.length,
      filesAfterStop: tapFiles(projectStateDir).length,
    };
  }),
);

recordCase(
  "adopts newly started pipe when ownership is reported late",
  { windowId: "@1", ownership: "late" },
  withTempProject((projectStateDir) => {
    let pendingOwnership;
    const tmux = createTmux({
      pipeTargetToFile: (_target, filePath, options) => {
        pendingOwnership = options?.ownership;
        writeFileSync(filePath, "late token output\n");
      },
    });
    const tap = new ExposePaneOutputTap({ projectStateDir, tmux });
    tap.start();
    tap.trackItems([item("a", "@1")]);
    const beforeOwnership = tap.read("@1") ?? null;
    markOwned({ ownership: pendingOwnership });
    const afterOwnership = tap.read("@1")?.output ?? null;
    tap.stop();
    return { beforeOwnership, afterOwnership, calls: tmux.calls, filesAfterStop: tapFiles(projectStateDir).length };
  }),
);

recordCase(
  "restarts tracked tap after ownership is lost while demand continues",
  { windowId: "@1", tokenRemoved: true },
  withTempProject((projectStateDir) => {
    let writes = 0;
    const tmux = createTmux({
      pipeTargetToFile: (_target, filePath, options) => {
        markOwned(options);
        writes += 1;
        writeFileSync(filePath, writes === 1 ? "stale output\n" : "fresh output\n");
      },
    });
    const tap = new ExposePaneOutputTap({ projectStateDir, tmux });
    tap.start();
    tap.trackItems([item("a", "@1")]);
    const firstOutput = tap.read("@1")?.output ?? null;
    rmSync(tapFiles(projectStateDir, ".token")[0], { force: true });
    tap.trackItems([item("a-fresh", "@1")]);
    const secondOutput = tap.read("@1")?.output ?? null;
    tap.stop();
    return {
      firstOutput,
      secondOutput,
      pipeCalls: tmux.calls.pipeTargetToFile.length,
      stopCalls: tmux.calls.stopPanePipe.length,
    };
  }),
);

recordCase(
  "retries pending start that never reports ownership",
  { maintenanceMs: 100, renewAtMs: [50, 101] },
  withTempProject((projectStateDir) => {
    let nowMs = Date.parse("2026-07-20T13:00:00.000Z");
    const tmux = createTmux({
      pipeTargetToFile: (_target, filePath) => {
        writeFileSync(filePath, "pending output\n");
      },
    });
    const tap = new ExposePaneOutputTap({ projectStateDir, tmux, maintenanceMs: 100, now: () => new Date(nowMs) });
    tap.start();
    tap.trackItems([item("a", "@1")]);
    nowMs += 50;
    tap.trackItems([item("a-renewed", "@1")]);
    const afterRenew = tmux.calls.pipeTargetToFile.length;
    nowMs += 51;
    tap.trackItems([item("a-retry", "@1")]);
    const output = {
      afterRenew,
      afterRetry: tmux.calls.pipeTargetToFile.length,
      read: tap.read("@1") ?? null,
      stats: tap.stats(),
    };
    tap.stop();
    return output;
  }),
);

recordCase(
  "preserves different live token seen by pending start",
  { windowId: "@1", foreignToken: "foreign-token" },
  withTempProject((projectStateDir) => {
    let pendingOwnership;
    let logPath = "";
    let piped = false;
    const tmux = createTmux({
      isPanePiped: () => piped,
      pipeTargetToFile: (_target, filePath, options) => {
        pendingOwnership = options?.ownership;
        logPath = filePath;
        writeFileSync(filePath, "foreign output\n");
      },
    });
    const tap = new ExposePaneOutputTap({ projectStateDir, tmux });
    tap.start();
    tap.trackItems([item("a", "@1")]);
    writeFileSync(pendingOwnership.tokenFilePath, `${process.pid}\tforeign-token\n`);
    const readBefore = tap.read("@1") ?? null;
    piped = true;
    tap.trackItems([item("a-still-demanded", "@1")]);
    const output = {
      readBefore,
      pipeCalls: tmux.calls.pipeTargetToFile.length,
      stopCalls: tmux.calls.stopPanePipe.length,
      logContent: readFileSync(logPath, "utf8"),
      tokenContainsForeign: readFileSync(pendingOwnership.tokenFilePath, "utf8").includes("foreign-token"),
      stats: tap.stats(),
    };
    tap.stop();
    return output;
  }),
);

recordCase(
  "preserves different live token when tracked ownership is lost",
  { windowId: "@1", foreignToken: "foreign-token" },
  withTempProject((projectStateDir) => {
    const tmux = createTmux({
      pipeTargetToFile: (_target, filePath, options) => {
        markOwned(options);
        writeFileSync(filePath, "owned output\n");
      },
    });
    const tap = new ExposePaneOutputTap({ projectStateDir, tmux });
    tap.start();
    tap.trackItems([item("a", "@1")]);
    const logPath = tapFiles(projectStateDir)[0];
    const tokenPath = tapFiles(projectStateDir, ".token")[0];
    writeFileSync(tokenPath, `${process.pid}\tforeign-token\n`);
    tap.trackItems([item("a-still-demanded", "@1")]);
    const output = {
      read: tap.read("@1") ?? null,
      pipeCalls: tmux.calls.pipeTargetToFile.length,
      stopCalls: tmux.calls.stopPanePipe.length,
      logContent: readFileSync(logPath, "utf8"),
      tokenContainsForeign: readFileSync(tokenPath, "utf8").includes("foreign-token"),
      stats: tap.stats(),
    };
    tap.stop();
    return output;
  }),
);

recordCase(
  "expires demand and stops active pane pipes on next read",
  { activeMs: 1000, readAfterMs: 1001 },
  withTempProject((projectStateDir) => {
    let nowMs = Date.parse("2026-07-20T13:00:00.000Z");
    const tmux = createTmux();
    const tap = new ExposePaneOutputTap({ projectStateDir, tmux, activeMs: 1000, now: () => new Date(nowMs) });
    tap.start();
    tap.trackItems([item("a", "@1")]);
    nowMs += 1001;
    const read = tap.read("@1") ?? null;
    return {
      read,
      stopCalls: tmux.calls.stopPanePipe,
      filesAfterExpiry: tapFiles(projectStateDir).length,
      stats: tap.stats(),
    };
  }),
);

recordCase(
  "reads and compacts bounded tap files",
  { maxBytes: 5, content: "0123456789" },
  withTempProject((projectStateDir) => {
    const tmux = createTmux({
      pipeTargetToFile: (_target, filePath, options) => {
        markOwned(options);
        writeFileSync(filePath, "0123456789");
      },
    });
    const tap = new ExposePaneOutputTap({ projectStateDir, tmux, maxBytes: 5 });
    tap.start();
    tap.trackItems([item("a", "@1")]);
    const snapshot = tap.read("@1");
    const contents = fileContents(projectStateDir);
    tap.stop();
    return { snapshot, contents };
  }),
);

recordCase(
  "compacts active tap files when demand is renewed",
  { maintenanceMs: 100, maxBytes: 5, renewAfterMs: 100 },
  withTempProject((projectStateDir) => {
    let nowMs = Date.parse("2026-07-20T13:00:00.000Z");
    const tmux = createTmux({
      pipeTargetToFile: (_target, filePath, options) => {
        markOwned(options);
        writeFileSync(filePath, "0123456789");
      },
    });
    const tap = new ExposePaneOutputTap({
      projectStateDir,
      tmux,
      activeMs: 1000,
      maintenanceMs: 100,
      maxBytes: 5,
      now: () => new Date(nowMs),
    });
    tap.start();
    tap.trackItems([item("a", "@1")]);
    const before = fileContents(projectStateDir);
    nowMs += 100;
    tap.trackItems([item("a-renewed", "@1")]);
    const after = fileContents(projectStateDir);
    tap.stop();
    return { before, after, stopCalls: tmux.calls.stopPanePipe.length };
  }),
);

recordCase(
  "does not stop pane pipe after ownership is lost",
  { tokenRemovedBeforeStop: true },
  withTempProject((projectStateDir) => {
    const tmux = createTmux({
      pipeTargetToFile: (_target, filePath, options) => {
        markOwned(options);
        writeFileSync(filePath, "output\n");
      },
    });
    const tap = new ExposePaneOutputTap({ projectStateDir, tmux });
    tap.start();
    tap.trackItems([item("a", "@1")]);
    rmSync(tapFiles(projectStateDir, ".token")[0], { force: true });
    tap.stop();
    return { stopCalls: tmux.calls.stopPanePipe.length, filesAfterStop: tapFiles(projectStateDir).length };
  }),
);

recordCase(
  "does not track pane when starting pipe fails",
  { pipeTargetToFile: "throws" },
  withTempProject((projectStateDir) => {
    const tmux = createTmux({
      pipeTargetToFile: () => {
        throw new Error("tmux unavailable");
      },
    });
    const tap = new ExposePaneOutputTap({ projectStateDir, tmux });
    tap.start();
    tap.trackItems([item("a", "@1")]);
    tap.stop();
    return {
      read: tap.read("@1") ?? null,
      stopCalls: tmux.calls.stopPanePipe.length,
      filesAfterStop: tapFiles(projectStateDir).length,
      stats: tap.stats(),
    };
  }),
);

const contract = {
  version: 1,
  source: "src/expose-pane-output-tap.ts",
  generatedBy: "scripts/capture-expose-pane-output-tap-contract.mjs",
  description:
    "Expose pane output tap ownership, adoption, renewal, expiry, compaction, and failure contracts captured by running TypeScript with mocked tmux calls.",
  constants: {
    EXPOSE_PANE_TAP_ACTIVE_MS,
    EXPOSE_PANE_TAP_MAINTENANCE_MS,
    EXPOSE_PANE_TAP_MAX_BYTES,
  },
  cases,
};

await writeContractJson(FIXTURE_PATH, contract);
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
