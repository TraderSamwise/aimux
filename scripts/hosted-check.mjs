#!/usr/bin/env node
/**
 * End-to-end proof for hosted mode.
 *
 * The unit tests cover every piece in isolation; this covers the one thing they
 * cannot — that a real bearer token, over a real listener, reaches a real
 * tmux-backed session, and that everything outside the operator allowlist is
 * refused by the whole stack rather than by a mock.
 *
 * Entirely self-contained: its own AIMUX_HOME, its own daemon port, its own
 * tmux session prefix, its own temp project. It never touches a developer's
 * real daemon, sessions or state.
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The shim, not `node dist/…`: the repo's one-shot-Node inventory exists to
// keep every invocation on this entrypoint.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repoRoot, "bin", "aimux");
const failures = [];

function fail(message) {
  failures.push(message);
  console.error(`  ✗ ${message}`);
}

function pass(message) {
  console.log(`  ✓ ${message}`);
}

function expect(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

async function expectStatus(label, response, expected) {
  const actual = response.status;
  expect(actual === expected, `${label} → ${expected} (got ${actual})`);
}

function hasTmux() {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll(label, attempts, intervalMs, fn) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await fn()) return true;
    } catch {
      // Keep polling: the thing we are waiting for may not exist yet.
    }
    await sleep(intervalMs);
  }
  fail(`timed out waiting for ${label}`);
  return false;
}

async function main() {
  if (!hasTmux()) {
    console.log("tmux is not installed — skipping hosted end-to-end check.");
    return 0;
  }
  if (!existsSync(cli)) {
    console.error(`Build first: ${cli} does not exist (yarn build)`);
    return 1;
  }

  // Ports first: anything that can throw belongs before the temp dirs exist,
  // so there is no window where a failure leaks them past the finally below.
  const hostedPort = await freePort();
  const daemonPort = await freePort();

  // NOT "aimux-*": the project registry drops temp paths with that prefix, and
  // a grant on an unresolvable project is refused by design.
  const home = mkdtempSync(join(tmpdir(), "hosted-check-home-"));
  const project = mkdtempSync(join(tmpdir(), "hosted-check-proj-"));
  const projectName = basename(project);
  const env = { ...process.env, AIMUX_HOME: home, AIMUX_DAEMON_PORT: String(daemonPort) };
  const run = (args, options = {}) =>
    execFileSync(cli, args, { env, cwd: project, encoding: "utf8", ...options });

  let sessionId = null;

  try {
    execFileSync("git", ["init", "-q", "-b", "master", "."], { cwd: project, stdio: "ignore" });

    // Hosted config is read once at daemon start, so it must exist first. The
    // shell tool and the tmux prefix are written here too: `shell` is not a
    // default tool, and a unique prefix keeps this run's tmux sessions
    // identifiable for teardown.
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify(
        {
          hosted: {
            enabled: true,
            bindAddress: "127.0.0.1",
            port: hostedPort,
            maxPromptBytes: 2048,
            // Raised well above the default: this script polls at 2/s, and the
            // 60/min default would empty mid-run on a loaded machine and turn
            // later assertions into 429s.
            rateLimit: { requestsPerMinute: 1000, maxConcurrent: 16 },
          },
          tools: {
            shell: { command: "bash", args: ["--norc", "-i"], enabled: true, promptPatterns: ["[$#] $"] },
          },
        },
        null,
        2,
      ),
    );

    console.log(`\nhosted-check: daemon :${daemonPort}, listener :${hostedPort}, home ${home}\n`);
    run(["daemon", "ensure"], { stdio: "ignore" });

    const spawned = JSON.parse(run(["spawn", "--tool", "shell", "--project", project, "--no-open", "--json"]));
    sessionId = spawned.sessionId;
    expect(Boolean(sessionId), `spawned a session (${sessionId})`);

    // Spawning is queued: the tmux window does not exist when the call returns.
    const projects = () => JSON.parse(run(["daemon", "projects", "--json"]));
    let servicePort = null;
    await poll("the project service to publish its port", 40, 250, () => {
      const entry = projects().projects?.find((candidate) => candidate.serviceEndpoint?.port);
      servicePort = entry?.serviceEndpoint?.port ?? null;
      return servicePort !== null;
    });
    if (!servicePort) throw new Error("no project service port");

    const { token } = (() => {
      const output = run(["hosted", "token", "create", "--label", "hosted-check"]);
      const match = output.match(/Token:\s+(\S+)/);
      return { token: match?.[1] ?? "" };
    })();
    expect(token.startsWith("amx_"), "created a bearer token");

    const principalId = JSON.parse(run(["hosted", "token", "list", "--json"]))[0].id;
    run(["hosted", "grant", principalId, "--project", project, "--session", sessionId]);
    pass(`granted ${principalId} → ${sessionId}`);

    const hosted = (path, init = {}) =>
      fetch(`http://127.0.0.1:${hostedPort}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });
    const proxy = (subPath) => `/proxy/127.0.0.1/${servicePort}${subPath}`;
    const readOutput = () => hosted(proxy(`/agents/output?sessionId=${encodeURIComponent(sessionId)}`));

    console.log("\nthe session responds");
    await poll("the session's pane to come up", 60, 500, async () => (await readOutput()).status === 200);

    const nonce = `hosted-check-${Date.now()}`;
    const sent = await hosted(proxy("/agents/input"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, text: `echo ${nonce}-$((6*7))` }),
    });
    await expectStatus("sending input", sent, 200);

    // Asserting on the ARITHMETIC RESULT, not the nonce: the typed line echoes
    // in the pane either way, so only "-42" proves the shell actually ran it.
    const echoed = await poll("the command's output to appear in the pane", 40, 500, async () => {
      const body = await (await readOutput()).json();
      return JSON.stringify(body).includes(`${nonce}-42`);
    });
    expect(echoed, "the session executed the operator's command and returned its output");

    console.log("\nthe allowlist holds");
    await expectStatus("no token", await fetch(`http://127.0.0.1:${hostedPort}${proxy("/agents/output")}`), 401);
    await expectStatus(
      "wrong token",
      await fetch(`http://127.0.0.1:${hostedPort}${proxy("/agents/output")}`, {
        headers: { authorization: "Bearer amx_wrong" },
      }),
      401,
    );
    await expectStatus(
      "forged owner header",
      await fetch(`http://127.0.0.1:${hostedPort}${proxy("/agents/output")}`, {
        headers: { "x-aimux-actor-role": "owner", "x-aimux-actor-user-id": "attacker" },
      }),
      401,
    );
    await expectStatus(
      "ungranted session",
      await hosted(proxy("/agents/output?sessionId=someone-elses-session")),
      403,
    );
    // Every denied route carries a GRANTED session id, so a 403 can only come
    // from the route allowlist. Without one they would 403 for the unrelated
    // reason that no session was named, and prove nothing.
    const granted = `sessionId=${encodeURIComponent(sessionId)}`;
    await expectStatus("session list", await hosted(proxy(`/agents?${granted}`)), 403);
    await expectStatus("output stream", await hosted(proxy(`/agents/output/stream?${granted}`)), 403);
    await expectStatus("events", await hosted(proxy(`/events?${granted}`)), 403);
    await expectStatus(
      "spawn",
      await hosted(proxy("/agents/spawn"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "shell", sessionId }),
      }),
      403,
    );
    await expectStatus(
      "kill",
      await hosted(proxy("/agents/kill"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      }),
      403,
    );
    await expectStatus("listener health, query string and all", await hosted("/health?x=1"), 200);
    // Proxy-shaped and a real daemon route, so this proves the gate refuses the
    // daemon itself rather than merely failing to match a path.
    await expectStatus("the daemon, proxied", await hosted(`/proxy/127.0.0.1/${daemonPort}/projects`), 403);
    await expectStatus("unshaped path", await hosted("/daemon/projects"), 404);
    await expectStatus(
      "oversized prompt",
      await hosted(proxy("/agents/input"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, text: "x".repeat(8_000) }),
      }),
      413,
    );

    console.log("\nlockdown");
    run(["hosted", "lockdown", "on"]);
    await sleep(1_200); // the listener caches the lockdown check for a second
    await expectStatus("granted route under lockdown", await readOutput(), 503);
    const health = await fetch(`http://127.0.0.1:${hostedPort}/health`);
    await expectStatus("health under lockdown", health, 200);
    expect((await health.json()).lockdown === true, "health reports the lockdown");
    run(["hosted", "lockdown", "off"]);
    await sleep(1_200);
    await expectStatus("granted route after lockdown", await readOutput(), 200);

    console.log("\nthe audit log");
    const audit = readFileSync(join(home, "hosted", "audit.jsonl"), "utf8");
    expect(audit.includes(principalId), "audit recorded the principal");
    expect(audit.includes(nonce), "audit recorded the prompt");
    expect(!audit.includes(token), "audit never recorded the token");
    // One, not three: failed-auth events are throttled per peer so a
    // credential-stuffing run cannot amplify into a webhook flood.
    expect(audit.includes("hosted_auth_failed"), "audit recorded the failed authentication");
  } catch (error) {
    fail(`threw: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      run(["daemon", "stop"], { stdio: "ignore" });
    } catch {
      // Only escalate if the graceful stop failed: `daemon kill` writes daemon
      // state files even when nothing is running, which would recreate the
      // very directory being torn down.
      try {
        run(["daemon", "kill"], { stdio: "ignore" });
      } catch {
        // Never came up.
      }
    }

    // tmux sessions outlive the daemon. They are matched on the temp project's
    // unique name rather than a configured prefix: `aimux init` writes a full
    // default project config, and project config overrides global, so a prefix
    // set globally would not survive.
    try {
      const sessions = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
      for (const name of sessions.split("\n").filter((line) => line.includes(projectName))) {
        try {
          execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
        } catch {
          // Gone already.
        }
      }
    } catch {
      // No tmux server running: nothing to clean.
    }

    // Wait for the daemon to actually exit before removing its home — it
    // rewrites state on the way down and would otherwise recreate the
    // directory we just deleted.
    await poll("the daemon to exit", 40, 250, async () => {
      try {
        await fetch(`http://127.0.0.1:${daemonPort}/health`, { signal: AbortSignal.timeout(200) });
        return false;
      } catch {
        return true;
      }
    });

    // Retried: a daemon on its way out can write into the tree while rmSync is
    // walking it, which surfaces as ENOTEMPTY rather than as anything worth
    // failing the run over.
    for (const directory of [home, project]) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          rmSync(directory, { recursive: true, force: true });
          break;
        } catch {
          await sleep(200);
        }
      }
    }
  }

  if (failures.length > 0) {
    console.error(`\nhosted-check failed with ${failures.length} problem(s).`);
    return 1;
  }
  console.log("\nhosted-check passed.");
  return 0;
}

process.exit(await main());
