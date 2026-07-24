# aimux

Aimux is a local agent multiplexer for AI coding tools. It keeps Claude, Codex,
Aider, and shell sessions running in real tmux windows, then gives you one
control plane for switching between them, coordinating work, and checking in
from terminal, browser, or mobile.

The important part: your tools keep their native TUIs. Aimux manages the runtime
around them.

## What It Does

- Runs each agent in its own long-lived tmux window.
- Groups agents by project and git worktree.
- Shows running, offline, graveyarded, and teammate sessions in one dashboard.
- Supports native resume where the underlying tool supports it.
- Exposes the same project state through terminal UI, CLI, web, mobile, and
  local scripts.
- Provides task, handoff, thread, review, notification, and metadata workflows
  through a daemon-backed project service.
- Keeps remote access optional. Execution stays local; remote clients connect to
  the local daemon through the relay.

## Install

### Homebrew

```bash
brew tap TraderSamwise/aimux
brew install aimux
```

Homebrew installs `node` and `tmux` dependencies and tracks the GitHub release
assets.

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

The npm package installs the `aimux` binary. Homebrew or the standalone
installer is the preferred path for normal local installs.

## Quick Start

```bash
# Open the dashboard for the current project
aimux

# Start a tool in a managed agent window
aimux claude
aimux codex
aimux aider

# Resume offline sessions
aimux --resume
```

Common control-plane commands:

```bash
aimux restart
aimux doctor versions
aimux spawn --tool codex --project /path/to/repo
aimux stop <sessionId> --project /path/to/repo
aimux kill <sessionId> --project /path/to/repo
aimux graveyard resurrect <id> --project /path/to/repo
aimux task assign "Audit the reconnect path" --project /path/to/repo
aimux thread list --project /path/to/repo --json
```

## Web And Mobile

The browser and native app live at [aimux.app](https://aimux.app). They are
clients of the same local control plane as the terminal dashboard.

Remote mode is opt-in:

```bash
aimux login
aimux remote enable
```

The local daemon remains the owner of execution. Web and mobile clients read and
mutate project state through the daemon/project-service APIs.

## Development

```bash
git clone https://github.com/TraderSamwise/aimux.git
cd aimux
yarn install
yarn build
```

Install the current checkout as a frozen local build:

```bash
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$(uname -m)" in arm64 | aarch64) ARCH=arm64 ;; x86_64 | amd64) ARCH=x64 ;; esac
AIMUX_RELEASE_VERSION=local-$(git rev-parse --short HEAD) yarn release:asset
scripts/install.sh "release/aimux-${PLATFORM}-${ARCH}.tar.gz"
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

Backend changes under `src/` do not affect the installed `aimux` command until
you build a release asset and install it.

## Requirements

- macOS or Linux
- Node.js 24+
- tmux
- At least one supported agent tool installed, such as `claude`, `codex`, or
  `aider`

## Documentation

- [Docs index](docs/README.md)
- [Full reference](docs/reference.md)
- [Current architecture](docs/current-architecture.md)
- [Core sidecar north star](docs/core-sidecar-north-star.md)
- [Deployment guide](docs/deployment.md)
- [Runtime lifecycle](docs/runtime-lifecycle.md)

## Release Channels

Releases publish from git tags to:

- [GitHub Releases](https://github.com/TraderSamwise/aimux/releases)
- [npm: aimux-cli](https://www.npmjs.com/package/aimux-cli)
- [Homebrew tap: TraderSamwise/aimux](https://github.com/TraderSamwise/homebrew-aimux)

## License

MIT. See [LICENSE](LICENSE).
