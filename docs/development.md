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

Common checks:

```bash
yarn typecheck
yarn lint
yarn vitest
```

Before asking someone to verify a runtime or CLI behavior change manually,
install a local release asset so the running daemon and project services are
using the code you changed.

Use `aimux doctor versions` to inspect daemon, project-service, dashboard, and
installed build coherence.

## Explicit Sandboxes

Use explicit overrides only when isolated state is required:

```bash
AIMUX_HOME=/tmp/aimux-scratch AIMUX_DAEMON_PORT=43201 aimux daemon restart
```

Keep normal development on the installed `aimux` lane so cross-project views,
restart behavior, and version diagnostics describe one runtime.
