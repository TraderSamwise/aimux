import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJsonPath = join(repoRoot, "package.json");
const gatePath = join(repoRoot, "scripts/installed-runtime-gate.py");
const python = process.env.PYTHON || "python3";

describe("installed runtime gate wiring", () => {
  it("keeps the installed-runtime gate in the release readiness lane", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

    expect(packageJson.scripts?.["installed:gate"]).toBe("python3 scripts/installed-runtime-gate.py");
    expect(packageJson.scripts?.["installed:local-gate"]).toBe(
      "python3 scripts/installed-runtime-gate.py --scenario local",
    );
    expect(packageJson.scripts?.["release:readiness"]).toContain("scripts/run-yarn installed:gate");
    expect(packageJson.scripts?.["release:readiness"]).toContain("scripts/run-yarn installed:local-gate");
    // One name for the lane an agent runs. verify:fast was an alias for it and
    // an alias is the cheapest way to make a script list look confusing.
    expect(packageJson.scripts?.["verify:fast"], "verify:fast folded into verify").toBeUndefined();
    expect(packageJson.scripts?.verify).toContain("scripts/run-yarn verify:push");
  });

  it("documents all user-visible installed runtime checks", () => {
    const result = spawnSync(python, [gatePath, "--list-checks"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "loop",
      "input",
      "liveness",
      "transcript",
      "git-leak",
      "sensitive-egress",
      "structural-boundary",
      "source-review",
    ]);
  });

  it("documents the installed runtime gate scenarios", () => {
    const result = spawnSync(python, [gatePath, "--list-scenarios"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["full", "local"]);
  });

  it("keeps a framed multiline body pending until one explicit submit", () => {
    const result = spawnSync(
      python,
      [
        "-c",
        String.raw`
import importlib.util, json, os, pty, select, signal, subprocess, sys, tempfile, termios, time
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('installed_gate_fixture', sys.argv[1])
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
def interrupted(signum, frame):
    raise TimeoutError('fixture driver terminated')
signal.signal(signal.SIGTERM, interrupted)
with tempfile.TemporaryDirectory(prefix='aimux-gate-receiver-test-') as directory:
    root = Path(directory)
    gate.write_config(SimpleNamespace(root=root, aimux_home=root / 'home'))
    helper = root / 'bin' / 'controlled-receiver' / 'codex'
    config = json.loads((root / 'home' / 'config.json').read_text())
    assert config['tools']['shell']['command'] == str(helper), 'shell alias must resolve the controlled protocol executable'
    assert helper.read_text().splitlines()[0] == '#!' + sys.executable
    master, slave = pty.openpty()
    saved = termios.tcgetattr(slave)
    child = None
    output = bytearray()
    def receive_until(predicate, label, timeout=3):
        deadline = time.monotonic() + timeout
        while not predicate(bytes(output)):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError('%s: timeout; output=%r' % (label, output))
            if select.select([master], [], [], min(remaining, 0.05))[0]:
                chunk = os.read(master, 65536)
                assert chunk, '%s: receiver output closed' % label
                output.extend(chunk)
            elif child.poll() is not None:
                raise AssertionError('%s: receiver exited %s; output=%r' % (label, child.returncode, output))
    def assert_pending():
        deadline = time.monotonic() + 0.15
        while time.monotonic() < deadline:
            assert child.poll() is None, 'receiver exited before submit'
            if select.select([master], [], [], 0.02)[0]:
                output.extend(os.read(master, 65536))
        assert b'GATE_INPUT:' not in output, 'embedded LF submitted early: %r' % output
    try:
        child = subprocess.Popen([str(helper)], stdin=slave, stdout=slave, stderr=slave,
            env={**os.environ, 'AIMUX_SESSION_ID': 'pty-test'})
        receive_until(lambda data: b'\x1b[?2004h' in data and b'GATE_READY:pty-test\r\n' in data, 'raw paste-ready receiver')
        assert termios.tcgetattr(slave) != saved, 'receiver never entered raw mode'
        output.clear()
        body = '1. café 界🙂\n\n  2. preserve\tindentation\n3. finish'.encode()
        os.write(master, b'\x1b[20')
        os.write(master, b'0~' + body)
        assert_pending()
        os.write(master, b'\x1b[201~')
        marker = ('› [Pasted Content %d chars]' % len(body.decode())).encode()
        receive_until(lambda data: marker in data, 'complete pasted-draft marker before submit')
        assert_pending()
        assert b'GATE_INPUT:' not in output
        output.clear()
        os.write(master, b'\r')
        expected = b'GATE_INPUT:' + body.replace(b'\n', b'\r\n') + '\r\n› '.encode()
        receive_until(lambda data: expected in data, 'complete body after submit')
        assert bytes(output) == expected, 'one submit must emit exactly the complete body: %r' % output
        output.clear()
        os.write(master, b'single-line-marker\r')
        single = 'GATE_INPUT:single-line-marker\r\n› '.encode()
        receive_until(lambda data: single in data, 'single-line input and empty composer')
        assert bytes(output) == single
        child.terminate()
        receive_until(lambda data: b'\x1b[?2004l' in data, 'paste-mode reset during shutdown')
        assert child.wait(timeout=2) == 0, 'receiver did not terminate cleanly'
        restored = termios.tcgetattr(slave)
        assert restored == saved, 'receiver left terminal settings changed: saved=%r restored=%r' % (saved, restored)
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            child.wait(timeout=2)
        os.close(master)
        os.close(slave)
`,
        gatePath,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 12_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
  }, 15_000);

  it("exposes one mutation switch for each installed-runtime check", () => {
    const source = readFileSync(gatePath, "utf8");

    expect(source).toContain('"loop-no-enroll"');
    expect(source).toContain('"input-drop"');
    expect(source).toContain('"liveness-skip-kill"');
    expect(source).toContain('"transcript-no-genuine"');
    expect(source).toContain('"git-leak-no-outer-ignore"');
    expect(source).toContain('"git-leak-no-attachments-rule"');
    expect(source).toContain('"sensitive-egress-nonloopback"');
    expect(source).toContain('"structural-boundary-remote-compiled"');
    expect(source).toContain('"source-review-missing-provenance"');
  });

  it("proves real local archives through install, strings, help, cargo tree, and variant refusals", () => {
    const source = readFileSync(gatePath, "utf8");

    expect(source).toContain('build_release_asset(work, "local")');
    expect(source).toContain('install_release_asset(local_asset, work, variant="local")');
    expect(source).toContain('"AIMUX_RELAY_URL"');
    expect(source).toContain('"relay.aimux.app"');
    expect(source).toContain('"tokio_tungstenite"');
    expect(source).toContain('"wss://"');
    expect(source).toContain('"cargo", "tree"');
    expect(source).toContain("release archive BUILD_VARIANT mismatch: expected local, got full");
    expect(source).toContain("release archive BUILD_VARIANT mismatch: expected full, got local");
  });

  it("wires the structural remote boundary into the installed local gate", () => {
    const source = readFileSync(gatePath, "utf8");

    expect(source).toContain('"structural-boundary"');
    expect(source).toContain('"node"');
    expect(source).toContain('"scripts/check-remote-structural-boundary.mjs"');
    expect(source).toContain('"--variant"');
    expect(source).toContain('"local"');
    expect(source).toContain('"structural-boundary-remote-compiled"');
  });

  it("adds the reviewer source-build path to the installed local gate", () => {
    const source = readFileSync(gatePath, "utf8");

    expect(source).toContain('"source-review"');
    expect(source).toContain('"git", "clone", "--quiet"');
    expect(source).toContain('"scripts/build-local-release-from-source.sh"');
    expect(source).toContain("reviewer source build matched release-lane local artifact surfaces");
    expect(source).toContain('"source-review-missing-provenance"');
  });

  it("keeps data-at-rest gates inside the installed runtime gate", () => {
    const source = readFileSync(gatePath, "utf8");

    expect(source).toContain("SENSITIVE_STORES");
    expect(source).toContain('"attachments"');
    expect(source).toContain('"worktrees"');
    expect(source).toContain('"git", "config", "core.excludesFile", "/dev/null"');
    expect(source).toContain('"git", "add", "-n"');
    expect(source).toContain("root_gitignore_has_aimux_entry");
    expect(source).toContain("AIMUX_DAEMON_HOST");
    expect(source).toContain("assert_no_non_loopback_network_surface");
  });
});
