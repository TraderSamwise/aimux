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
  // Hoisted for the teardown: the project service is its OWN process and
  // outlives `daemon stop`, so the home cannot be removed until it is gone too.
  let servicePort = null;

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
    // Every denial below carries a GRANTED session id, so a 403 can only come
    // from the route allowlist rather than from naming no session at all.
    const granted = `sessionId=${encodeURIComponent(sessionId)}`;

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

    console.log("\nthe stream carries what the session does");
    {
      const streamNonce = `hosted-stream-${Date.now()}`;
      const controller = new AbortController();
      // Bounded: this body never ends on its own, so without an abort a
      // regression would hang CI instead of failing it.
      const guard = setTimeout(() => controller.abort(), 20_000);
      try {
        const stream = await hosted(proxy(`/agents/output/stream?${granted}&intervalMs=250`), {
          signal: controller.signal,
        });
        await expectStatus("opening a stream on a granted session", stream, 200);
        expect(
          (stream.headers.get("content-type") ?? "").includes("text/event-stream"),
          "the stream is served as text/event-stream",
        );
        // The project service sets a wildcard CORS header on this route; the
        // listener must synthesize its own rather than forward it.
        expect(
          stream.headers.get("access-control-allow-origin") === null,
          "the stream does not carry the upstream's wildcard CORS header",
        );

        await hosted(proxy("/agents/input"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, text: `echo ${streamNonce}-$((6*7))` }),
        });

        // Same standard as above: the typed line echoes either way, so only the
        // arithmetic result proves the stream carried real execution.
        const decoder = new TextDecoder();
        const reader = stream.body.getReader();
        let seen = "";
        let carried = false;
        while (!carried) {
          const { done, value } = await reader.read();
          if (done) break;
          seen += decoder.decode(value, { stream: true });
          carried = seen.includes(`${streamNonce}-42`);
        }
        await reader.cancel();
        expect(carried, "the stream delivered the command's output live");
      } catch (error) {
        fail(`streaming: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(guard);
        controller.abort();
      }
    }

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
    await expectStatus("session list", await hosted(proxy(`/agents?${granted}`)), 403);
    // The stream is allowed for a GRANTED session, so the denial worth proving
    // is the ungranted one. `/events` stays refused outright: it is
    // project-wide, so it would carry other operators' sessions.
    await expectStatus(
      "output stream for an ungranted session",
      await hosted(proxy("/agents/output/stream?sessionId=someone-elses-session")),
      403,
    );
    await expectStatus("events", await hosted(proxy(`/events?${granted}`)), 403);
    await expectStatus(
      "conflicting session ids across body and query",
      await hosted(proxy(`/agents/input?sessionId=someone-elses-session`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, text: "echo hi\n" }),
      }),
      403,
    );
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
    expect(!audit.includes(token), "audit never recorded the token");
    // Bodies live in their own file so a flood of refused requests cannot push
    // everyone else's records out of a size-rotated one.
    const prompts = readFileSync(join(home, "hosted", "audit-prompts.jsonl"), "utf8");
    expect(prompts.includes(nonce), "the prompt body was kept, in the prompts file");
    expect(!audit.includes(nonce), "the prompt body is not in the record file");
    expect(!prompts.includes(token), "the prompts file never recorded the token");
    expect(
      audit.includes("hosted_stream_open") && audit.includes("hosted_stream_closed"),
      "audit recorded the stream opening and closing",
    );

    console.log("\nrevocation");
    {
      // The case the live re-check exists for: a stream authenticates once, at
      // open, so without it a revoked operator keeps reading until the stream's
      // own lifetime runs out — and the idle timeout cannot help, because the
      // project service sends a keepalive on every poll. Asserting only that a
      // NEW stream is refused would pass with the re-check deleted.
      const controller = new AbortController();
      let timedOut = false;
      const guard = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 30_000);
      try {
        const live = await hosted(proxy(`/agents/output/stream?${granted}&intervalMs=250`), {
          signal: controller.signal,
        });
        await expectStatus("a stream open before revocation", live, 200);
        const reader = live.body.getReader();
        await reader.read();

        run(["hosted", "token", "revoke", principalId]);

        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
        expect(!timedOut, "revoking the token ended the stream already in flight");
      } catch (error) {
        fail(`mid-flight revocation: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(guard);
        controller.abort();
      }
    }

    await expectStatus("granted route after revocation", await readOutput(), 401);
    await expectStatus(
      "opening a stream after revocation",
      await hosted(proxy(`/agents/output/stream?${granted}`)),
      401,
    );
    expect(
      readFileSync(join(home, "hosted", "audit.jsonl"), "utf8").includes("hosted_stream_closed:revoked"),
      "the audit says the stream ended because the token was revoked",
    );
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

    // Wait for the daemon AND the project service to exit before removing the
    // home. Both rewrite state on the way down and would otherwise recreate the
    // directory just deleted — and the service is a SEPARATE process, so
    // `daemon stop` does not settle it. Waiting only on the daemon leaked a
    // home directory on every single run.
    const gone = async (port) => {
      try {
        await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(200) });
        return false;
      } catch {
        return true;
      }
    };
    await poll("the daemon to exit", 40, 250, () => gone(daemonPort));
    if (servicePort) await poll("the project service to exit", 60, 250, () => gone(servicePort));

    // Removed until it STAYS removed. A daemon writes its state on the way
    // down, and it stops answering /health before it finishes doing so — so a
    // successful rmSync is not evidence the tree is gone, only that it was
    // gone for an instant. Checking afterwards is what makes this reliable;
    // without it every run left a home directory behind.
    for (const directory of [home, project]) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch {
          // Mid-write: ENOTEMPTY here is expected, not worth failing the run.
        }
        await sleep(200);
        if (!existsSync(directory)) break;
      }
      if (existsSync(directory)) fail(`leaked ${directory}`);
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
