import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TEMPORARIES = [];
const SCRIPTS = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
const HOSTS = ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"];

function temporary() {
  const root = mkdtempSync(join(tmpdir(), "aimux-linux-toolchain-"));
  TEMPORARIES.push(root);
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "state"));
  return root;
}

function executable(root, name, body) {
  const path = join(root, "bin", name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function jobs(workflow) {
  return [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\s*\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:|$(?![\s\S]))/gm)].map(
    ([, name, body]) => ({ name, body }),
  );
}

function buildsRelease(body, seen = new Set()) {
  if (/build-release-asset\.sh|installed-runtime-gate\.py|build-(?:local-)?release-from-source\.sh/.test(body))
    return true;
  const calls = [...body.matchAll(/(?:scripts\/run-yarn|\byarn)\s+(?:run\s+)?([a-z][a-z0-9:_-]*)/g)];
  return calls.some(([, name]) => {
    if (seen.has(name) || !SCRIPTS[name]) return false;
    seen.add(name);
    return buildsRelease(SCRIPTS[name], seen);
  });
}

function setupCommand(body) {
  const setup = /      - name: Prepare static Linux[^\n]*\n([\s\S]*?)(?=\n      - |$)/.exec(body);
  if (!setup) throw new Error("release-building Linux job has no static toolchain preparation");
  const run = /        run: \|\n([\s\S]*)/.exec(setup[1]);
  if (!run) throw new Error("static toolchain preparation has no executable run block");
  return run[1]
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n")
    .trim();
}

function workflowBuilders() {
  return ["ci", "release"].flatMap((workflow) =>
    jobs(readFileSync(join(ROOT, `.github/workflows/${workflow}.yml`), "utf8"))
      .filter(({ body }) => buildsRelease(body) && !/runs-on:\s*macos/.test(body))
      .map((job) => ({ ...job, name: `${workflow}/${job.name}` })),
  );
}

function executeSetup(command, host) {
  const root = temporary();
  executable(root, "apt-get", 'case " $* " in *" musl-tools "*) printf ready > "$FIXTURE_STATE/compiler";; esac');
  executable(root, "sudo", 'exec "$@"');
  executable(root, "rustc", 'printf "rustc fixture\\nhost: %s\\n" "$FIXTURE_HOST"');
  executable(
    root,
    "rustup",
    'if [ "$1" = target ] && [ "$2" = add ]; then\n  [ "$3" = "$FIXTURE_TARGET" ] || exit 94\n  printf ready > "$FIXTURE_STATE/stdlib"\nfi',
  );
  for (const name of ["curl", "sh", "rm"]) executable(root, name, "exit 0");
  const result = spawnSync(
    "/bin/bash",
    ["-euo", "pipefail", "-c", `${command}\ntest -f "$FIXTURE_STATE/compiler"\ntest -f "$FIXTURE_STATE/stdlib"`],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:/usr/bin:/bin`,
        FIXTURE_STATE: join(root, "state"),
        FIXTURE_HOST: host,
        FIXTURE_TARGET: host.replace(/-gnu$/, "-musl"),
      },
    },
  );
  expect(result.error).toBeUndefined();
  return result;
}

function generatedDockerfile(mode, arch) {
  const root = temporary();
  const docker = executable(
    root,
    "docker",
    [
      'case "$1" in',
      '  build) shift; while [ "$#" -gt 0 ]; do if [ "$1" = -f ]; then cp "$2" "$FIXTURE_DOCKERFILE"; fi; shift; done;;',
      '  run) printf "%s\\n" "$@" > "$FIXTURE_DOCKER_ARGS";;',
      "  *) exit 95;;",
      "esac",
    ].join("\n"),
  );
  executable(root, "uname", 'printf "%s\\n" "$FIXTURE_ARCH"');
  const result = spawnSync("/bin/bash", [join(ROOT, "scripts/linux-release-repro.sh"), mode], {
    encoding: "utf8",
    env: {
      ...process.env,
      DOCKER: docker,
      TMPDIR: root,
      PATH: `${join(root, "bin")}:/usr/bin:/bin`,
      FIXTURE_ARCH: arch,
      FIXTURE_DOCKERFILE: join(root, "Dockerfile"),
      FIXTURE_DOCKER_ARGS: join(root, "docker.args"),
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return {
    dockerfile: readFileSync(join(root, "Dockerfile"), "utf8"),
    args: readFileSync(join(root, "docker.args"), "utf8"),
  };
}

function dockerSetup(dockerfile) {
  const commands = [...dockerfile.matchAll(/^RUN ([\s\S]*?)(?=\n\n|$(?![\s\S]))/gm)]
    .map(([, command]) => command)
    .filter((command) => /apt-get install|sh\.rustup\.rs|rustup target add/.test(command));
  expect(commands.length).toBeGreaterThanOrEqual(2);
  return commands.join("\n");
}

afterEach(() => {
  for (const root of TEMPORARIES.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Linux release builder prerequisites", () => {
  it("provisions musl for every Linux job that builds release assets", () => {
    const builders = workflowBuilders();
    expect(builders.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "ci/linux-packaging",
        "ci/installed-gate",
        "ci/installed-local-gate",
        "release/release-assets",
      ]),
    );
    for (const { name, body } of builders) {
      const command = setupCommand(body);
      for (const host of HOSTS) {
        const result = executeSetup(command, host);
        expect(result.status, `${name} ${host}: ${result.stderr}`).toBe(0);
      }
      if (name === "release/release-assets")
        expect(body).toMatch(/name: Prepare static Linux toolchain\n\s+if: matrix\.platform == 'linux'/);
    }
  });

  it("detects omitted compiler and target installation in the actual CI setup commands", () => {
    for (const { name, body } of workflowBuilders()) {
      const command = setupCommand(body);
      for (const [label, mutation] of [
        ["compiler", command.replace(/musl-tools/g, "fixture-without-musl")],
        ["target", command.replace(/rustup target add "\$target"/g, ":")],
      ]) {
        expect(mutation, `${name} has no ${label} mutation target`).not.toBe(command);
        expect(executeSetup(mutation, HOSTS[0]).status, `${name} accepted missing ${label}`).not.toBe(0);
      }
    }
  });

  it.each(["installed", "readiness"])(
    "provisions both Linux architectures in the generated %s Docker image",
    (mode) => {
      for (const host of HOSTS) {
        const { dockerfile, args } = generatedDockerfile(mode, host.startsWith("x86_64") ? "x86_64" : "aarch64");
        const result = executeSetup(dockerSetup(dockerfile), host);
        expect(result.status, result.stderr).toBe(0);
        expect(args).toContain(
          mode === "installed" ? "yarn installed:gate && yarn installed:local-gate" : "yarn release:readiness",
        );
      }
    },
  );

  it("detects missing compiler and target setup in the generated Docker image", () => {
    const { dockerfile } = generatedDockerfile("installed", "x86_64");
    const command = dockerSetup(dockerfile);
    for (const mutation of [
      command.replace(/musl-tools/g, "fixture-without-musl"),
      command.replace(/rustup target add "\$target"/g, ":"),
    ]) {
      expect(mutation).not.toBe(command);
      expect(executeSetup(mutation, HOSTS[0]).status).not.toBe(0);
    }
  });

  it("refuses an unknown Rust host before claiming a usable target", () => {
    for (const { body } of workflowBuilders())
      expect(executeSetup(setupCommand(body), "x86_64-apple-darwin").status).not.toBe(0);
  });
});
