# Aimux Development

Use `yarn` for package commands.

## Setup

```bash
git clone https://github.com/TraderSamwise/aimux.git
cd aimux
yarn install
yarn build
```

Aimux has one normal CLI lane: the installed `aimux` command. It runs from a
frozen release bundle under `~/.aimux/native/`, uses `~/.aimux`, and talks to
the local daemon on port `43190` unless explicit environment overrides are set.

Do not point `~/.local/bin/aimux` directly at this checkout for normal
development.

## Backend Loop

Code under `src/` runs from `dist/` inside the installed bundle. Building this
checkout validates source and updates local `dist/`, but it does not update a
running installed Aimux runtime.

For backend, daemon, project-service, or tmux-runtime changes:

```bash
yarn build
AIMUX_RELEASE_VERSION=local-$(git rev-parse --short HEAD) yarn release:asset
ASSET="$(ls -t release/aimux-*.tar.gz | head -n 1)"
scripts/install.sh "$ASSET"
aimux doctor versions
```

The installer restarts and repairs the daemon, project services, managed tmux
contract, and dashboard windows without killing agent panes.

## App Loop

The production browser app is [aimux.app](https://aimux.app). The same Expo
client also targets the upcoming iOS and Android apps.

Run the local web app with Expo HMR:

```bash
aimux daemon ensure
cd app
yarn dev:web:local
```

Native dev builds:

```bash
cd app
yarn dev:ios:local
yarn dev:android:local
```

After a native dev build is installed, use Metro-only HMR:

```bash
cd app
yarn dev:native:local
```

Run local app builds against the production relay:

```bash
cd app
yarn dev:web:relay
yarn dev:native:relay
```

The app connection target is controlled by:

```bash
EXPO_PUBLIC_AIMUX_CONNECTION_MODE=local|relay
EXPO_PUBLIC_AIMUX_DAEMON_URL=http://localhost:43190
EXPO_PUBLIC_AIMUX_RELAY_URL=wss://relay.aimux.app
```

Development builds default to local mode. Production builds default to relay
mode.

## Verification

There are four lanes and they are not interchangeable. If you are unsure which
to run, the answer is `yarn verify`.

| lane | who runs it | what it is |
| --- | --- | --- |
| `yarn verify` | you, after every change | Typecheck, lint, fmt, clippy and the static audits. ~20s. |
| `yarn verify:push` | the pre-push hook | Typechecks plus the commit-hook attestation. You do not run this by hand. |
| `yarn verify:full` | CI, and the cutover install gate | `verify` plus every Rust, root JS and app JS suite. Minutes. |
| `yarn release:readiness` | the release gate | `verify:full` plus the idle-spawn budget and the installed-runtime gates. |

`release:readiness` doubles as the manifest of what CI must cover: a test
asserts every leaf of it runs in some CI job, so adding a step there without a
CI job fails the build.

Full suites are CI's job. A Claude Code hook in this repo refuses `native:test`,
`verify:full`, `release:readiness`, an unscoped `cargo test` and a bare
`yarn test`, and prints the scoped command instead. Prefix with
`AIMUX_ALLOW_FULL_SUITE=1` when the full lane is genuinely what you want.

For one change, run the targets covering what you touched plus `yarn verify`:

```bash
cargo test --manifest-path native/Cargo.toml -p aimux --test <the_test_you_touched>
yarn vitest run <path/to/the.test.ts>
yarn verify
```

Before asking someone to verify a runtime or CLI behavior change manually,
install a local release asset so the running daemon and project services are
using the code you changed.

Use `aimux doctor versions` to inspect daemon, project-service, dashboard, and
installed build coherence.

## Remote Clipboard

Aimux managed tmux sessions copy mouse selections with tmux `copy-pipe` and the
session `copy-command`, which is `pbcopy` on macOS. When you connect to that Mac
from another machine over mosh, the copy lands on the host Mac clipboard, not on
the mosh client clipboard. mosh also drops tmux's empty-selector OSC 52 clipboard
sequence, so Aimux cannot reliably turn that tmux copy action into a local client
clipboard update over mosh. Use ssh in a terminal that permits OSC 52, or use the
terminal's native selection, when the clipboard must land on the client machine.

## Explicit Sandboxes

Harnesses and live-drive checks use explicit overrides to keep test state away
from the installed runtime:

```bash
AIMUX_HOME=/tmp/aimux-scratch AIMUX_DAEMON_PORT=43201 aimux daemon restart
```

This is an internal testing pattern, not a second user daemon lane. Keep normal
development on the installed `aimux` runtime so cross-project views, restart
behavior, and version diagnostics describe one control plane.
