# aimux

Aimux is a local agent multiplexer for AI coding tools. It keeps Claude,
Codex, Aider, and shell sessions running in real tmux windows, scoped to a
project checkout or one of that project's git worktrees.

Aimux does not replace those tools' native TUIs. It manages the runtime around
them and exposes one control plane through the terminal dashboard, CLI, web app,
mobile app, and relay-backed shared chats.

## What It Does

- Runs long-lived agent and service sessions in managed tmux windows.
- Groups sessions by project and git worktree.
- Provides dashboard actions for spawning, stopping, forking, resurrecting, and
  coordinating sessions.
- Keeps shared project state behind a local daemon and one daemon-managed
  project service per active project.
- Lets web and mobile clients use the same control-plane APIs as the terminal.
- Supports optional relay access for the owner's own devices.
- Supports shared chats as a separate receiver experience; guests do not need
  their own daemon, CLI, relay, or local project.

Execution stays local. Remote clients relay requests to the owner's running
local daemon and project service.

## App

Aimux includes a browser app at [aimux.app](https://aimux.app). The app is for
remote access to your own running Aimux daemon, shared chat invitations, and
the web version of the project control plane.

The iOS and Android apps use the same Expo client and are the upcoming native
surfaces for the same workflows.

## Install

### Homebrew

```bash
brew tap TraderSamwise/aimux
brew install aimux
```

### Standalone

```bash
curl -fsSL https://raw.githubusercontent.com/TraderSamwise/aimux/master/scripts/install.sh | sh
```

The installer places a frozen release under `~/.aimux/native/` and links
`aimux` into `~/.local/bin`. Reinstalling over an existing install repairs the
daemon, project services, tmux runtime contract, and dashboard windows without
killing agent panes.

Install a specific release:

```bash
curl -fsSL https://raw.githubusercontent.com/TraderSamwise/aimux/master/scripts/install.sh | AIMUX_VERSION=vX.Y.Z sh
```

### npm

```bash
npm install -g aimux-cli
```

Homebrew or the standalone installer is preferred for normal local installs.

## Quick Start

```bash
# Open the dashboard for the current project
aimux

# Start a tool in a managed agent window
aimux claude
aimux codex
aimux aider

# Repair daemon/service/dashboard/tmux drift
aimux restart

# Inspect installed runtime coherence
aimux doctor versions
```

Common control-plane commands:

```bash
aimux spawn --tool codex --project /path/to/repo
aimux stop <sessionId> --project /path/to/repo
aimux kill <sessionId> --project /path/to/repo
aimux graveyard resurrect <id> --project /path/to/repo
aimux task assign "Audit the reconnect path" --project /path/to/repo
aimux thread list --project /path/to/repo --json
```

## Remote Access And Sharing

The web and native clients are clients of the same local control plane as the
terminal dashboard.

Owner remote access is opt-in:

```bash
aimux login
aimux remote enable
```

Shared chats are orthogonal to a receiver's own projects. A receiver can accept
and use a shared chat from `aimux.app` even if they have no local Aimux install
or daemon running. If they do run their own Aimux install, project workflows and
shared chats remain separate top-level app areas.

## Development

```bash
git clone https://github.com/TraderSamwise/aimux.git
cd aimux
yarn install
yarn build
```

Backend code under `src/` runs from `dist/` inside the installed bundle.
Building this checkout is not enough to update a running `aimux` install. For
backend changes, build and install a local release asset:

```bash
AIMUX_RELEASE_VERSION=local-$(git rev-parse --short HEAD) yarn release:asset
ASSET="$(ls -t release/aimux-*.tar.gz | head -n 1)"
scripts/install.sh "$ASSET"
aimux doctor versions
```

For the Expo web/mobile client:

```bash
cd app
yarn dev:web:local
yarn dev:native:local
yarn dev:ios:local
yarn dev:android:local
```

Local web against the production relay:

```bash
cd app
yarn dev:web:relay
```

## Requirements

- macOS or Linux
- Node.js 24+
- tmux
- At least one supported agent tool installed, such as `claude`, `codex`, or
  `aider`

## Documentation

- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [Deployment](docs/deployment.md)
- [Sharing](docs/sharing.md)
- [Security](docs/security.md)

## Release Channels

Releases publish from git tags to:

- [GitHub Releases](https://github.com/TraderSamwise/aimux/releases)
- [npm: aimux-cli](https://www.npmjs.com/package/aimux-cli)
- [Homebrew tap: TraderSamwise/aimux](https://github.com/TraderSamwise/homebrew-aimux)

## License

MIT. See [LICENSE](LICENSE).
