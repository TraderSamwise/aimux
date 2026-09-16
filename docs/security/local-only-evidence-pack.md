# Aimux Lite Local-Only Evidence Pack

Audience: corporate security reviewers evaluating whether the Aimux lite build
lane is suitable for a work laptop where Aimux remote control is not allowed.

## Honest Boundary

This evidence pack is scoped to the Aimux binary, release artifacts,
and Aimux-managed local control plane. Runtime network claims apply to the
installed Aimux binary and its child control-plane processes; install/update
scripts are provenance and integrity surfaces, not runtime local-only proof.
Aimux launches user-selected agent CLIs
such as Codex, Claude, Aider, and shells. Those tools are separate executables
and may be network clients. Installing `aimux-lite` does not make spawned agent
tools local-only; it makes the Aimux control plane and release lane enforce the
properties below.

## Reviewer Entry Points

Run these from a clean checkout:

```bash
yarn security:local-only:gate
CARGO_INCREMENTAL=0 bash scripts/check-lite-build-boundary.sh --variant lite
CARGO_INCREMENTAL=0 bash scripts/check-lite-build-boundary.sh --variant full
bash scripts/verify-release-asset-set.sh <release-dir>
```

For a published release, also verify GitHub artifact attestations:

```bash
gh attestation verify <asset> --repo TraderSamwise/aimux
gh attestation verify <asset>.sha256 --repo TraderSamwise/aimux
gh attestation verify <asset>.provenance.json --repo TraderSamwise/aimux
gh attestation verify <asset>.sbom.spdx.json --repo TraderSamwise/aimux
```

## Enforced Claims

### Lite Has No Non-Loopback Remote-Control Dependency Graph

Property: the `lite` native feature closure must not include remote-control
network client crates used by Aimux relay or hosted paths. This is not a
"no sockets" claim: lite legitimately contains local bind/listen/connect and
name-resolution machinery for the daemon, project service, and loopback
proxy/stream paths.

Enforcing check:

```bash
CARGO_INCREMENTAL=0 bash scripts/check-lite-build-boundary.sh --variant lite
```

The check runs `cargo tree --no-default-features` and fails if the lite graph
contains `tokio-tungstenite`, `tungstenite`, `ureq`, `reqwest`, `hyper`, `h2`,
`native-tls`, `openssl`, or `curl`. It deliberately does not ban `tokio`,
`mio`, or `socket2`, because Aimux still needs local loopback listeners.

Violation behavior: the check prints
`Lite cargo tree contains remote-control dependencies:` followed by the matched
dependency lines and exits nonzero.

### Lite Has No Remote-Control CLI Surface

Property: `aimux-lite` must not advertise remote-control commands.

Enforcing check:

```bash
bash scripts/check-lite-build-boundary.sh --variant lite --archive <lite-asset> --platform-arch <platform>-<arch>
```

The check runs `aimux --help` from the archive and fails if `remote`, `hosted`,
`login`, `logout`, `whoami`, or `security` appear as top-level commands.

Violation behavior: the check prints
`Lite --help lists remote-control commands:` with the offending help rows and
exits nonzero.

### Lite Has No Remote/Hosted Runtime Identities

Property: `aimux-lite` must not contain Aimux relay, hosted-mode, non-loopback
remote-control, or attachment-hosting identities in the binary.

Enforcing check:

```bash
bash scripts/check-lite-build-boundary.sh --variant lite --archive <lite-asset> --platform-arch <platform>-<arch>
```

The string denylist includes relay URL/config identities, WebSocket schemes,
relay modules, hosted modules, remote login/security modules, and hosted
attachment publishing identities.

Violation behavior: the check prints
`Lite binary contains remote-control strings:` followed by each match and exits
nonzero.

### Full Variant Still Proves Its Opposite

Property: the full lane must remain full. It must still contain the expected
remote-control dependency, help, and relay URL/config surface.

Enforcing check:

```bash
CARGO_INCREMENTAL=0 bash scripts/check-lite-build-boundary.sh --variant full
```

Violation behavior: the check prints one of:

- `Full cargo tree is missing remote-control dependencies`
- `Full --help is missing remote-control commands`
- `Full binary is missing relay URL/config strings`

This is the full-variant equivalent of the lite absence check. It prevents a
broken release from accidentally publishing a neutered full binary under the
existing full artifact names.

### Install Lane Rejects Variant Mismatch

Property: a full archive cannot be installed through the lite path, and a lite
archive cannot be installed through the full path.

Enforcing checks:

```bash
AIMUX_INSTALL_VARIANT=lite bash scripts/install.sh <archive>
AIMUX_INSTALL_VARIANT=full bash scripts/install.sh <archive>
```

Violation behavior: the installer exits nonzero with
`release archive BUILD_VARIANT mismatch: expected <lane>, got <stamp>`.

### Release Assets Are Complete And Untampered

Property: a release cannot publish downstream if any full/lite platform asset,
checksum, provenance file, or SBOM is missing, unreadable, stale, corrupt, or
assigned to the wrong variant.

Enforcing check:

```bash
bash scripts/verify-release-asset-set.sh <release-dir>
```

The gate verifies:

- every full and lite platform archive exists;
- every `.sha256` file exists, names the expected asset, and passes `shasum -c`;
- every archive is a readable tarball containing `VERSION`, `BUILD_STAMP`,
  `BUILD_VARIANT`, and `native/<platform>-<arch>/aimux`;
- every archive `BUILD_VARIANT` matches its lane;
- every `.provenance.json` exists and names the same artifact, SHA256,
  variant, platform, and git revision;
- every `.sbom.spdx.json` exists and is a nonempty SPDX 2.3 document.

Violation behavior: the gate exits nonzero and names the exact asset and
comparison, for example `checksum mismatch for release asset`, `release asset
is not a readable tar.gz archive`, `missing release SBOM file`, or
`provenance sha256 mismatch`.

### Release Artifacts Carry Verifiable Provenance

Property: reviewers can connect a git tag and workflow identity to the exact
asset, checksum, provenance, and SBOM files they download.

Enforcing checks:

```bash
node scripts/write-release-provenance.mjs ...
node scripts/verify-release-provenance.mjs <release-dir> <asset> <platform-arch> <variant>
gh attestation verify <asset> --repo TraderSamwise/aimux
```

The release workflow generates per-asset provenance JSON and an SPDX SBOM,
uploads both beside the archive, and uses GitHub artifact attestations for the
archive plus companion files. The `verify-release-assets` job downloads the
complete set, verifies content locally, then verifies the published
attestations before npm or Homebrew jobs can run.

Violation behavior: missing or stale provenance/SBOM files fail
`verify-release-asset-set.sh`; missing or invalid attestations fail the release
workflow at `Verify release asset attestations`.

### Homebrew And npm Consume Only Verified Assets

Property: formula checksums and npm native binaries must be derived only after
the complete release asset set passes verification.

Enforcing check:

```bash
yarn security:local-only:gate
```

The source gate asserts both `publish-npm` and `update-homebrew-tap` depend on
`verify-release-assets`, and that the workflow uploads/downloads provenance and
SBOM companions for every asset. npm remains full-only; `aimux-lite` is a
Homebrew formula that downloads only lite artifacts and conflicts with the full
formula while installing the command as `aimux`.

Violation behavior: the gate prints `Local-only release gate failed:` followed
by the missing workflow dependency or asset companion and exits nonzero.

### Runtime Control-Plane Network Scope Is Loopback

Property: Aimux lite may open local sockets, but control-plane HTTP listeners
and proxy targets must be loopback-only and must not establish non-loopback
runtime remote-control connections.

Enforcing checks:

```bash
CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/tmp/aimux-cargo-target-$AIMUX_SESSION_ID \
  cargo test --manifest-path native/Cargo.toml -p aimux --test daemon_state

CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/tmp/aimux-cargo-target-$AIMUX_SESSION_ID \
  cargo test --manifest-path native/Cargo.toml -p aimux --test project_service_process
```

The daemon host parser rejects `AIMUX_DAEMON_HOST=0.0.0.0`, and the project
service binds `127.0.0.1`. Proxy and stream tests separately reject non-loopback
upstream targets. gqaapg-137 also ran an isolated runtime smoke with isolated
`AIMUX_HOME`, `AIMUX_DAEMON_PORT`, and `AIMUX_TMUX_SOCKET_PATH`; it observed
only `127.0.0.1` daemon/project-service listeners and no non-loopback `lsof`
connections. That smoke should be promoted into a stable script gate before
claiming runtime monitoring is fully automated.

Violation behavior: the Rust tests fail with messages naming the non-loopback
host or the expected loopback endpoint.

### Project `.aimux` Stores Are Ignored By Default

Property: initialized project-local Aimux stores must not be accidentally staged
into the user's repository.

Enforcing checks:

```bash
yarn check:local-build-boundary
CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/tmp/aimux-cargo-target-$AIMUX_SESSION_ID \
  cargo test --manifest-path native/Cargo.toml -p aimux --test config
```

The initialized `.aimux/.gitignore` template ignores context, history, tasks,
status, threads, attachments, graveyard, recordings, plans, worktrees, and
state files.

Violation behavior: `yarn check:local-build-boundary` reports which store is no
longer ignored, and the Rust config test fails if the generated template drifts.

## Required Sibling Gates Not Claimed Green Here

The data-at-rest audit found that some non-secret transcript, attachment,
project-state, and log stores still use umask defaults today. `~/.aimux/auth.json`
and several hosted secret/audit files already use `0600`, but the owner-only
construction/repair guarantee for all sensitive stores is owned by gqaapg-144.
Once that lands, this evidence pack should reference its stable command as an
enforcing check for:

- project `.aimux/context`, `.aimux/history`, `.aimux/attachments`,
  `.aimux/graveyard`, and runtime exchange files;
- `~/.aimux/projects/*` state and log files;
- repair of existing permissive files on startup/upgrade;
- inverse proof under permissive `umask` that `0644`/`0755` construction fails.

Until that gate is green, the local-only claim must not be expanded to
"all Aimux local state is owner-only by construction."

