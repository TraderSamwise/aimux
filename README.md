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
- Optionally hosts named operators: other people, each pinned to the sessions
  they were granted and nothing else, with their own audit trail.

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

## Hosted Mode

Remote mode gives *you* your own machine from somewhere else. Hosted mode is the
other question: letting **other people** talk to particular agent sessions on it
— a colleague, or an application whose users need an assistant — without giving
any of them the machine.

It is opt-in and off by default. An installation that never enables it is
unaffected by all of it.

Configure it in `~/.aimux/config.json` — the **global** config only. A `hosted`
block in a project config is stripped on load, since project config is committed
in repos and cloning one should not open a listener.

```jsonc
{
  "hosted": { "enabled": true, "bindAddress": "127.0.0.1", "port": 43195 }
}
```

```bash
aimux restart
aimux hosted status  # prints the startup verdict, not just the config
```

### Principals And Grants

A principal is a bearer token plus the list of sessions it may drive. The token
is shown once, and the label is opaque to aimux — use whatever identifier the
calling system knows people by, because it appears in every audit record.

```bash
aimux hosted token create --label "grand:admin:user_2abc"
aimux hosted grant prn_a1b2c3 --project /srv/grand --session assistant
aimux hosted ungrant prn_a1b2c3 --project /srv/grand --session assistant
aimux hosted token list
aimux hosted token revoke prn_a1b2c3
```

A grant names a project root **and** a session id, because session ids are
unique only within a project.

### What An Operator Can Reach

Six routes, on granted sessions only — read the pane, send it text, set the
context attached to its prompts, interrupt a turn, upload an image, read one
back — plus `GET /agents/output/stream` to follow a pane as Server-Sent Events.

Everything else is refused: spawn, fork, stop, kill, migrate, worktrees,
services, graveyard, threads, tasks, shell state, and every daemon-level route.
So is the session list, which would leak other operators' session ids, and the
project-wide event stream, which would carry their sessions to anyone
subscribed.

Revocation reaches a stream already in flight, within seconds — a stream
authenticates once at open, so without a live re-check a revoked holder would
keep reading for the rest of its ten-minute lifetime.

### Prompt Context

`POST /agents/prompt-context` holds a line of text that aimux prepends to every
message the session is sent — what page the person is on, which record they are
editing. It is mutable, replaced or cleared at any time (`text: ""`), and
expires by itself after thirty minutes so a closed tab cannot leave a context
quietly steering an agent. Empty and omitted for most sessions; capped at 4 KB
of text.

The route is write-only, and that is **not** secrecy: the context is composed
into the prompt, so it lands in the pane, and anyone granted `GET
/agents/output` on that session reads it there.

### Audit, Events, Lockdown

Every request appends a JSONL record to `~/.aimux/hosted/audit.jsonl` — who,
when, which session, status, byte counts, and the prompt's hash. Prompt bodies
go to a separate file so that one operator's large bodies cannot rotate away
everyone else's records.

```bash
aimux hosted audit tail -n 50
aimux hosted audit tail --prompts
```

This log is the only place operators can be told apart: a single signed-in tool
account cannot distinguish them, so treat it as the record of record.

With a webhook configured, aimux posts HMAC-signed connection events — a token's
first use, a known token from an unseen device, repeated failures, revocations,
grant changes, lockdown. Aimux reports; what a human sees is the receiving
system's decision.

```bash
aimux hosted lockdown on     # every hosted route 503s before authentication
aimux hosted lockdown off
```

Lockdown does not touch tmux, the loopback surface, or the relay. Operators lose
their door; the owner keeps theirs.

### Before You Deploy It

**Keep `bindAddress` on loopback and put a tunnel in front** — there is no TLS
here, and binding off-loopback with no active principals is refused outright.
Put an authenticating front door (Cloudflare Access with a service token, mTLS)
in front of the tunnel: the hostname is public DNS, so without one the whole
internet reaches the pre-authentication path with a bearer token as the only
gate.

And be clear about what this boundary is. An operator who can send text to a
session is talking to a tool with a shell, so the line that carries weight is
the machine and its credentials — not the route allowlist. A host that wants
that line drawn can install the optional [egress
sandbox](docs/egress-sandbox.md), which default-denies the runtime uid's
outbound network access.

`yarn check:hosted` exercises the whole path end to end against a real daemon,
listener and tmux session — proving a granted command executes and every other
route is refused. Run it after changing anything in the hosted path.

Full detail, including the threat model and every limit:
[hosted mode](docs/hosted-mode.md) and its
[RFC](docs/hosted-mode-rfc.md).

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
- [Hosted mode](docs/hosted-mode.md) and its [RFC](docs/hosted-mode-rfc.md)
- [Egress sandbox](docs/egress-sandbox.md)

## Release Channels

Releases publish from git tags to:

- [GitHub Releases](https://github.com/TraderSamwise/aimux/releases)
- [npm: aimux-cli](https://www.npmjs.com/package/aimux-cli)
- [Homebrew tap: TraderSamwise/aimux](https://github.com/TraderSamwise/homebrew-aimux)

## License

MIT. See [LICENSE](LICENSE).
