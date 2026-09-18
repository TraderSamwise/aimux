# Aimux Local Source Review Evidence Pack

Audience: corporate security reviewers reading the Aimux source tree to decide
whether the local build variant is acceptable on a work laptop.

This is a source-review guide, not an artifact-release checklist. The intended
workflow is that a reviewer reads the named source files, builds the local
variant themselves, and reruns the same checks from the same checkout. Prebuilt
release artifacts and provenance files are supporting release-lane evidence;
they are not the primary trust anchor for this review.

## Honest Boundary

This evidence pack is scoped to the Aimux binary and Aimux-managed local control
plane: the daemon, per-project service, CLI, dashboard/TUI state, tmux runtime
integration, local HTTP listeners, and files Aimux writes.

Aimux launches user-selected agent CLIs such as Codex, Claude, Aider, and
shells. Those tools are separate executables and may be network clients. A local
Aimux build does not make the machine offline and does not prove that spawned
agent tools are local-only. The agent processes remain a separate user and
corporate trust decision.

## Reviewer Starting Point

Start with the source separation. The first local-only review question is not
"which artifact did Aimux publish?" It is "which source is reachable when the
remote-control feature is absent?"

Primary source check:

- `native/crates/aimux/src/lib.rs` should contain the single gated entry point
  for the remote implementation module tree:

  ```rust
  #[cfg(feature = "remote-control")]
  pub mod remote;
  ```

- `native/crates/aimux/src/remote/mod.rs` should be the module tree that
  re-exports relay, hosted, login, remote credential, remote security-device,
  mobile push bridge, websocket, and remote CLI code. The remote CLI surface is
  a normal gated module in that tree rather than being hidden behind a macro.
- This does not claim there is only one `#[cfg(feature = "remote-control")]`
  site in the source tree. In this checkout, grep for the exact attribute
  `#[cfg(feature = "remote-control")]` and you should find 70 sites across 11
  source files. Forty-eight of those are concentrated in three files:
  `daemon/runtime.rs` (26), `attachment_hosting.rs` (13), and
  `daemon/remote_control.rs` (9). The remaining sites are
  `core_cli_executor.rs` (7), `core_cli.rs` (4), `async_runtime.rs` (4),
  `bin/aimux.rs` (2), `project_service/project_events.rs` (2),
  `project_service/runtime_health_history.rs` (1), `native_cli_dispatch.rs`
  (1), and `lib.rs` (1). There are zero such cfg attributes inside
  `src/remote/` itself. Those sites are call-site adapters or local/full
  selection points, not scattered remote implementation islands.
- `native/crates/aimux/src/request_actor.rs` should remain outside
  `src/remote`; it is core request-context/shared-chat actor plumbing, not a
  remote-control transport module.
- `native/Cargo.toml` currently has one workspace member, `crates/aimux`.
  There is no separate `remote` crate and no single cross-crate dependency edge
  that proves the boundary by itself.
- `native/crates/aimux/Cargo.toml` should make `remote-control` a default
  feature and should attach remote network crates only to that feature.
- A local build must use `--no-default-features`; a full build uses the default
  feature set.

Independent confirmation:

```bash
rg -n 'cfg\(feature = "remote-control"\)|pub mod remote' native/crates/aimux/src
rg -l '#\[cfg\(feature = "remote-control"\)\]' native/crates/aimux/src | sort
rg -n '#\[cfg\(feature = "remote-control"\)\]' native/crates/aimux/src/remote || true
rg -n '#\[cfg\(feature = "remote-control"\)\]' native/crates/aimux/src \
  | cut -d: -f1 | sort | uniq -c | sort -nr
grep -n '^members' -A5 native/Cargo.toml
sed -n '1,80p' native/crates/aimux/Cargo.toml
sed -n '1,120p' native/crates/aimux/src/lib.rs
sed -n '1,160p' native/crates/aimux/src/remote/mod.rs
```

Expected result: the reviewer should be able to explain remote reachability from
one remote implementation module gate, reviewed call-site gates, and the Cargo
feature graph. If grep shows `#[cfg(feature = "remote-control")]` sites inside
`src/remote/`, remote implementation modules outside `src/remote`, or remote
implementation code hidden behind independent gates, this source-review claim
fails. If the reviewed count is not 70 sites across 11 files in this checkout,
update this document before using it in a review.

## Self-Build Verification Path

A source reviewer should build from the reviewed checkout rather than trust a
prebuilt Aimux artifact.

Primary source-build sequence:

```bash
yarn install --frozen-lockfile
yarn --cwd app install --frozen-lockfile
yarn release:source:local
```

`release:source:local` is defined in `package.json` as the local wrapper around
`scripts/build-local-release-from-source.sh`, which execs
`scripts/build-release-from-source.sh --variant local`. That source helper sets
`AIMUX_BUILD_VARIANT=local` and `AIMUX_PACKAGE_PROFILE=minimal`, builds
`release/aimux-local-<platform>-<arch>.tar.gz`, verifies release provenance and
SBOMs, runs the local boundary check, and installs into an isolated temporary
root with `AIMUX_SKIP_POST_INSTALL_RESTART=1`. The local-only security claim is
the build variant and feature set; the package profile controls archive
contents such as UI/docs assets. The package-profile axis is `full|minimal`;
`local` names the build variant, not the package profile.

Independent source check for that command path:

```bash
node -e 'const p=require("./package.json"); console.log(p.scripts["release:source:local"])'
sed -n '1,80p' scripts/build-local-release-from-source.sh
sed -n '1,180p' scripts/build-release-from-source.sh
```

Independent decomposition of the same source property:

```bash
CARGO_INCREMENTAL=0 \
  CARGO_TARGET_DIR=/tmp/aimux-local-review-target \
  cargo build --manifest-path native/Cargo.toml -p aimux --release --no-default-features

CARGO_INCREMENTAL=0 \
  CARGO_TARGET_DIR=/tmp/aimux-full-review-target \
  cargo build --manifest-path native/Cargo.toml -p aimux --release
```

Then run the local boundary check against the reviewer-built local binary:

```bash
bash scripts/check-local-build-boundary.sh \
  --variant local \
  --binary /tmp/aimux-local-review-target/release/aimux
```

And run the opposite check against the reviewer-built full binary:

```bash
bash scripts/check-local-build-boundary.sh \
  --variant full \
  --binary /tmp/aimux-full-review-target/release/aimux
```

The first command should prove absence of remote-control dependencies, CLI
surface, and binary identities. The second should prove the full variant still
contains the remote-control surface. Proving the opposite side matters: it
guards against a broken check that always passes because it never finds remote
code in any build. The installed local gate also runs the structural remote-tree
check, so it proves that a local build did not compile `src/remote` units, not
only that strings and `--help` output were absent.

Release archives, if reviewed, should be treated as a reproducibility target:

```bash
yarn release:source:local
```

The archive path is secondary. The source property is the `--no-default-features`
build and the source-owned gate that verifies the resulting binary.

## Enforced Source Claims

### 1. Remote-Control Source Is Structurally Separated

Property: relay, hosted mode, remote login, remote credentials, remote security
devices, remote attachment hosting, mobile push bridge, and websocket transport
live under the remote implementation module gated from `lib.rs`. Phase 1 moved
the remote-control implementation modules under `src/remote`; phase 1c keeps
the remote CLI cluster under that same remote tree rather than using a macro.
The boundary is not a physically separate crate: `native/Cargo.toml` has one
workspace member, `crates/aimux`. Remaining `remote-control` cfg sites outside
`src/remote` must be call-site adapters or local/full selection points, not
independent remote implementation modules.

Source locations:

- `native/crates/aimux/src/lib.rs`
- `native/crates/aimux/src/remote/mod.rs`
- `native/crates/aimux/src/remote/`
- `native/crates/aimux/src/remote/cli.rs`
- `native/crates/aimux/src/request_actor.rs`
- `native/Cargo.toml`
- `native/crates/aimux/Cargo.toml`
- `scripts/check-remote-structural-boundary.mjs`
- `scripts/check-local-build-boundary.sh`
- `scripts/installed-runtime-gate.py`

Independent confirmation:

```bash
rg -n 'relay|hosted|remote_login|remote_credentials|remote_security|mobile_push_bridge|websocket' \
  native/crates/aimux/src/remote native/crates/aimux/src/lib.rs native/crates/aimux/Cargo.toml
rg -n '#\[cfg\(feature = "remote-control"\)\]' native/crates/aimux/src
rg -l '#\[cfg\(feature = "remote-control"\)\]' native/crates/aimux/src | sort
rg -n '#\[cfg\(feature = "remote-control"\)\]' native/crates/aimux/src/remote || true
rg -n '#\[cfg\(feature = "remote-control"\)\]' native/crates/aimux/src \
  | cut -d: -f1 | sort | uniq -c | sort -nr
find native/crates/aimux/src/remote -maxdepth 1 -name '*.rs' -type f | sort
sed -n '1,120p' native/crates/aimux/src/request_actor.rs
grep -n '^members' -A5 native/Cargo.toml

cargo tree --manifest-path native/Cargo.toml -p aimux --no-default-features
cargo tree --manifest-path native/Cargo.toml -p aimux
```

Expected result: the local tree should not include remote-control dependency
crates such as `tokio-tungstenite`, `tungstenite`, or `ureq`; the full tree
should include them. The exact cfg grep should account for 70 reviewed sites
across 11 files, and zero of those sites should be inside `src/remote/`. Each
non-remote hit should be read, not waved away; a hit that defines remote
transport behavior outside `src/remote` invalidates this claim. The structural
checker should fail if old remote files such as `relay_client.rs`,
`hosted_server.rs`, or `mobile_push_bridge.rs` reappear outside `src/remote`,
or if local dep-info shows compiled `src/remote` units.

### 2. Local Build Has No Remote-Control Dependency Graph

Property: a local build must not depend on Aimux's remote-control network client
crates. This is not a "no sockets" claim: the local daemon and project services
still use local loopback sockets.

Source locations:

- `native/crates/aimux/Cargo.toml`
- `scripts/check-local-build-boundary.sh`

Independent confirmation:

```bash
cargo tree --manifest-path native/Cargo.toml -p aimux --no-default-features
rg -n 'tokio-tungstenite|tungstenite|ureq' \
  scripts/check-local-build-boundary.sh native/crates/aimux/Cargo.toml
```

Expected result: the boundary script denylist names the remote-control client
dependencies it rejects in the local variant, and those dependencies are tied to
the `remote-control` feature in Cargo. This is not a rejection of local loopback
HTTP dependencies used by Aimux's same-machine control plane.

### 3. Local Build Has No Remote-Control CLI Surface

Property: local `aimux --help` must not advertise remote-control commands such
as `remote`, `hosted`, `login`, `logout`, `whoami`, or `security`.

Source locations:

- `native/crates/aimux/src/bin/aimux.rs`
- `native/crates/aimux/src/native_cli_dispatch.rs`
- `native/crates/aimux/src/remote/cli.rs`
- `scripts/check-local-build-boundary.sh`

Independent confirmation:

```bash
/tmp/aimux-local-review-target/release/aimux --help
rg -n 'remote|hosted|login|logout|whoami|security|remote-control' \
  native/crates/aimux/src/bin/aimux.rs \
  native/crates/aimux/src/core_cli.rs \
  native/crates/aimux/src/core_cli_executor.rs \
  native/crates/aimux/src/native_cli_dispatch.rs \
  native/crates/aimux/src/remote/cli.rs
```

Expected result: remote commands are feature-gated out of local help and command
dispatch. The remote CLI cluster is intentionally a normal gated module at
`src/remote/cli.rs`, not a macro, so a source reviewer can read the full remote
command surface in one place. The boundary script should fail if those commands
appear in local help output.

### 4. Local Build Has No Remote-Control Binary Identities

Property: local Aimux must not contain relay, hosted, remote-login, or hosted
attachment publishing identities in the compiled binary.

Source locations:

- `scripts/check-local-build-boundary.sh`
- `native/crates/aimux/src/remote/`

Independent confirmation:

```bash
strings /tmp/aimux-local-review-target/release/aimux \
  | rg 'AIMUX_RELAY_URL|relay[.]aimux[.]app|wss://|ws://|hosted_server|hosted_cli|remote_login|remote_security_devices|attachments/hosted'
```

Expected result: no matches in the local binary. The same strings should be
present in the full binary, and the boundary script should check both
directions.

Published v0.1.42 linux-x64 artifact spot check:

```bash
tmp="$(mktemp -d /tmp/aimux-v0142-verify.XXXXXX)"
cd "$tmp"
gh release download v0.1.42 --repo TraderSamwise/aimux \
  --pattern 'aimux-linux-x64.tar.gz' \
  --pattern 'aimux-local-linux-x64.tar.gz'
mkdir full local
tar -xzf aimux-linux-x64.tar.gz -C full
tar -xzf aimux-local-linux-x64.tar.gz -C local
wc -c < full/aimux/native/linux-x64/aimux
wc -c < local/aimux/native/linux-x64/aimux
strings full/aimux/native/linux-x64/aimux | rg -c 'tungstenite|wss://'
strings local/aimux/native/linux-x64/aimux | rg -c 'tungstenite|wss://' || printf '0\n'
```

Expected result for the published v0.1.42 linux-x64 artifacts: the full binary
is `23922208` bytes and has `145` `tungstenite|wss://` string matches; the
local binary is `20190856` bytes and has `0` matches. This is supporting
artifact evidence for the source boundary; it does not replace the source-build
verification path above.

### 5. Control-Plane Network Scope Is Loopback

Property: local Aimux may open local sockets, but daemon/project-service
control-plane listeners and proxy targets must be loopback-scoped.

Source locations:

- `native/crates/aimux/src/daemon_state.rs`
- `native/crates/aimux/src/project_service/process.rs`
- `native/crates/aimux/tests/daemon_state.rs`
- `native/crates/aimux/tests/project_service_process.rs`
- `scripts/installed-runtime-gate.py`

Independent confirmation:

```bash
rg -n 'AIMUX_DAEMON_HOST must be loopback|127\\.0\\.0\\.1|localhost|0\\.0\\.0\\.0' \
  native/crates/aimux/src/daemon_state.rs \
  native/crates/aimux/src/project_service/process.rs \
  native/crates/aimux/tests/daemon_state.rs \
  native/crates/aimux/tests/project_service_process.rs

CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/tmp/aimux-local-review-target \
  cargo test --manifest-path native/Cargo.toml -p aimux --test daemon_state

CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/tmp/aimux-local-review-target \
  cargo test --manifest-path native/Cargo.toml -p aimux --test project_service_process
```

Expected result: non-loopback daemon host values are rejected, project service
binding is loopback, and tests cover the inverse case rather than treating query
failure as "no listeners."

### 6. Sensitive Aimux Stores Are Owner-Only

Property: sensitive Aimux-created stores are `0700` directories and `0600`
files on Unix platforms, including existing files repaired during
upgrade/startup. This covers the project-local `.aimux` sensitive directories
enumerated by `LOCAL_AIMUX_SENSITIVE_DIRS` (`attachments`, `context`,
`history`, `logs`, `plans`, `recordings`, `session-input-ops`,
`session-messages`, `status`, `tasks`, and `threads`), home-level `~/.aimux`
state except `native`, and project-state/runtime trees including runtime
exchange and runtime topology. Graveyard entries stored in runtime topology are
covered by the project-state repair path. Intentionally executable/source
artifacts are explicit exceptions: `.aimux/worktrees`, `.aimux/plugins`, and
`~/.aimux/native`.

Source locations:

- `native/crates/aimux/src/secure_permissions.rs`
- `native/crates/aimux/src/atomic_write.rs`
- `native/crates/aimux/src/config.rs`
- `native/crates/aimux/src/daemon/runtime.rs`
- `native/crates/aimux/src/project_service/process.rs`
- `native/crates/aimux/tests/secure_permissions.rs`

Independent confirmation:

```bash
sed -n '1,260p' native/crates/aimux/src/secure_permissions.rs
rg -n 'repair_global_aimux_home|repair_registered_project_local_stores|repair_project_state_store|ensure_private_dir|PRIVATE_FILE_MODE|PRIVATE_DIR_MODE' \
  native/crates/aimux/src native/crates/aimux/tests/secure_permissions.rs

CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/tmp/aimux-local-review-target \
  cargo test --manifest-path native/Cargo.toml -p aimux --test secure_permissions -- --test-threads=1
```

Expected result: the test creates stores under permissive `umask`, asserts
`0700`/`0600`, and separately asserts upgrade repair of stale public modes,
including registered inactive projects.

What this does not claim: retention is not uniform across every sensitive store.
The data-at-rest audit found mixed retention policies. Owner-only permissions
are now enforced for the enumerated Unix stores; retention should remain a
separate review item. This also does not claim a separate project-local
`.aimux/graveyard/` directory is protected unless that store is added to
`LOCAL_AIMUX_SENSITIVE_DIRS` and the permission test fixture.

### 7. Project `.aimux` Stores Are Ignored By Default

Property: initialized project-local Aimux stores must not be accidentally staged
into the user's repository.

Source locations:

- `native/crates/aimux/src/config.rs`
- `native/crates/aimux/tests/config.rs`
- `scripts/check-local-build-boundary.mjs`
- `scripts/installed-runtime-gate.py`

Independent confirmation:

```bash
rg -n 'context/|history/|tasks/|status/|threads/|attachments/|graveyard/|recordings/|plans/|worktrees/|ROOT_GITIGNORE' \
  native/crates/aimux/src/config.rs native/crates/aimux/tests/config.rs scripts/check-local-build-boundary.mjs

CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/tmp/aimux-local-review-target \
  cargo test --manifest-path native/Cargo.toml -p aimux --test config
```

Expected result: project init creates both the inner `.aimux/.gitignore` store
template and the root `.gitignore` containment rule for `.aimux/`, including
attachments and graveyard. The installed runtime gate mutates the ignore path to
prove the check can fail.

### 8. Local Runtime Egress Gate Samples The Installed Control Plane

Property: while sensitive stores exist, the installed local Aimux control plane
must not expose a non-loopback network surface. This claim is about Aimux daemon
and project-service processes, not spawned agent CLIs.

Source locations:

- `scripts/installed-runtime-gate.py`
- `scripts/check-remote-structural-boundary.mjs`
- `package.json`

Independent confirmation:

```bash
rg -n 'structural-boundary|check-remote-structural-boundary|sensitive-egress|nonloopback|lsof|control_plane_pids|installed:local-gate' \
  scripts/installed-runtime-gate.py scripts/check-remote-structural-boundary.mjs package.json
```

Expected result: the installed-runtime gate builds/installs an isolated local
variant, runs the structural remote-tree boundary check, creates sensitive
stores, samples Aimux control-plane PIDs, and fails if any sampled TCP row is
non-loopback. The mutation paths inject a compiled-remote dep-info row and a
temporary non-loopback listener, and expect the gate to fail in each case.

### 9. Release Lane Keeps Full And Local Variants Distinct

Property: full and local variants are built from the same source tree but with
different feature sets, archive names, formula names, and dependency graphs.

Source locations:

- `.github/workflows/release.yml`
- `package.json`
- `scripts/build-release-from-source.sh`
- `scripts/build-local-release-from-source.sh`
- `scripts/build-release-asset.sh`
- `scripts/install.sh`
- `scripts/verify-release-asset-set.sh`
- `scripts/generate-cargo-sbom.py`
- `scripts/verify-release-provenance.sh`
- `native/crates/aimux/src/release_version_contract.rs`
- `native/crates/aimux/src/runtime_coherence.rs`
- `docs/deployment.md`

Independent confirmation:

```bash
rg -n 'release:source:local|AIMUX_BUILD_VARIANT|AIMUX_PACKAGE_PROFILE|aimux-local|BUILD_VARIANT|PACKAGE_PROFILE|no-default-features|Formula/aimux-local' \
  package.json .github/workflows/release.yml scripts docs/deployment.md
rg -n 'read_aimux_runtime_build_variant|DEFAULT_BUILD_VARIANT|build variant' \
  native/crates/aimux/src/release_version_contract.rs \
  native/crates/aimux/src/runtime_coherence.rs \
  native/crates/aimux/src/daemon/runtime.rs

bash scripts/verify-release-asset-set.sh <release-dir>
```

Expected result: the local archive uses the local variant stamp and
`--no-default-features`; full uses the default feature set. The installer should
reject a full archive through the local install path and reject a local archive
through the full path. `aimux doctor versions` reports the runtime build
variant from a `BUILD_VARIANT` file or explicit environment evidence; when there
is no such evidence, the source path reports `unknown`, not an inferred `full`.

### 10. SBOMs Are Reproducible From Source

Property: full and local release lanes publish separate SPDX 2.3 SBOMs generated
from the same Cargo dependency graph used to compile that lane. A reviewer can
regenerate the expected package set from the source checkout without trusting a
prebuilt artifact.

Source locations:

- `scripts/generate-cargo-sbom.py`
- `scripts/verify-release-provenance.sh`
- `scripts/verify-release-asset-set.sh`

Independent confirmation:

```bash
python3 scripts/generate-cargo-sbom.py \
  --manifest-path native/Cargo.toml \
  --asset aimux-local-<platform>-<arch>.tar.gz \
  --asset-sha256 <archive-sha256> \
  --version <release-version> \
  --source-revision <reviewed-commit-sha> \
  --variant local \
  --platform-arch <platform>-<arch> \
  --output /tmp/aimux-local.sbom.spdx.json
```

Expected result: local SBOM generation uses `--no-default-features`; full SBOM
generation uses the default graph. `verify-release-provenance.sh` should reject
an SBOM whose package or relationship set does not match the selected variant.

## What Is Still Not Claimed

- This document does not claim spawned agent CLIs are local-only.
- This document does not claim the machine is offline.
- This document does not claim every sensitive store has a uniform retention
  policy. Owner-only permissions are enforced; retention is a separate policy
  surface.
