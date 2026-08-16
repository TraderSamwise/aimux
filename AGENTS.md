# Aimux Agent Instructions

## Instruction Files

- `AGENTS.md` is the canonical shared instruction file for this repository.
- `CLAUDE.md` is a Claude Code adapter and should import `AGENTS.md` with
  `@AGENTS.md`.
- Do not symlink `CLAUDE.md` to `AGENTS.md`; keep the adapter explicit so it
  works across tools and platforms.
- Add nested instruction files only when a subtree needs different rules.
- Keep durable project conventions here, not only in a single agent's private
  memory.

## Product Context

Aimux is an agent multiplexer. It runs long-lived Claude, Codex, Aider, and
shell sessions in tmux windows scoped to a project checkout or one of that
project's git worktrees. The dashboard, CLI, web app, and mobile app are clients
of the same local control plane.

Agents inside Aimux coordinate through Aimux task, handoff, and thread commands
backed by the runtime exchange. Do not directly spawn or control other agents
unless the user gives an explicit Aimux CLI/API command. Do not proactively
write `.aimux/plans/*` or `.aimux/status/*` for simple questions, read-only
inspections, or one-shot tasks.

## Architecture Boundaries

Aimux separates local execution from shared product state. See
`docs/architecture.md` for the maintained overview.

- The global daemon owns project discovery, project activation, and supervision
  of per-project services.
- The per-project service (`src/metadata-server.ts`) is the API authority for
  shared project state and lifecycle mutations.
- The managed tmux runtime owns terminal execution: panes, windows, PTYs,
  scrollback, attach/detach, and same-machine focus behavior.
- Clients include the terminal dashboard, Expo web/mobile app, CLI helpers,
  scripts, and plugins. They should use daemon and project-service APIs for
  shared reads and mutations.

When changing dashboard or app behavior, preserve that boundary:

- Use `src/multiplexer/dashboard-control.ts` helpers for TUI reads and
  mutations that affect shared project state.
- Keep response contracts aligned with `src/project-api-contract.ts` and
  app wrappers in `app/lib/api.ts`.
- Do not add direct dashboard writes to runtime-exchange, notification stores,
  thread/task/review state, topology, worktree, or graveyard state.
- Treat `statusline.json` as derived/debug state, not a primary transport.

## App (`app/`)

The browser and native clients live in `app/`. It is one Expo Router app for
web, iOS, and Android.

- `app/app/`: route screens.
- `app/components/`: shared UI.
- `app/lib/api.ts`: typed daemon and project-service HTTP wrappers.
- `app/lib/heartbeat.ts`: project SSE subscriptions.
- `app/stores/`: Jotai state.

Durable app preferences belong in `app/stores/settings.ts`. Keep transient UI
state in UI stores and shared project data behind API-backed resource stores.

Shared terminal/chat formatting belongs in `app/lib/ansi.ts` and
`app/lib/terminal-output.ts`; GUI chat, terminal mode, Expose tiles, and
previews should reuse those helpers instead of parsing terminal output in
screen components.

## Shared Chats

Shared chats are orthogonal to a receiver's own projects. A receiver can use
Aimux as a shared-chat participant without running a local daemon, CLI, relay,
or project service.

Do not mix shared receiver navigation with the receiver's project navigation.
The shared receiver surface should not expose owner project administration
views such as Expose, topology, worktrees, graveyard, services, or library.

GUI shared-chat messages are attributed before they enter the agent input
stream, for example `[sam@example.com] Help us make a document.` Local TUI and
non-GUI input should not be rewritten with shared user prefixes.

## Local Development

Use `yarn` for package commands.

```bash
yarn install
yarn build
```

The normal CLI lane is the installed `aimux` command under `~/.aimux/native/`.
Do not point `~/.local/bin/aimux` directly at this checkout for normal
development.

For backend, daemon, project-service, or tmux-runtime changes:

```bash
yarn build
AIMUX_RELEASE_VERSION=local-$(git rev-parse --short HEAD) yarn release:asset
ASSET="$(ls -t release/aimux-*.tar.gz | head -n 1)"
scripts/install.sh "$ASSET"
aimux doctor versions
```

For app development:

```bash
cd app
yarn dev:web:local
yarn dev:native:local
yarn dev:ios:local
yarn dev:android:local
```

## Verification

Source checks do not prove that the live installed runtime changed. Before
asking someone to manually verify CLI or runtime behavior, install a local
release asset as shown above.

Common checks:

```bash
yarn typecheck
yarn lint
yarn vitest
```

Use `aimux doctor versions` to inspect daemon, project-service, dashboard, and
installed build coherence.

## Releases

Local CLI releases publish from git tags to GitHub Releases, npm, and the
Homebrew tap.

The web app deploys from pushed commits through the configured Vercel project.
Do not deploy the web app manually from a local working tree.

Native app releases use the shared release scripts from `app/`:

```bash
cd app
yarn version:bump-ota && yarn update
yarn version:bump-build && yarn build
```

The default native release lane is TestFlight. Use `production`-targeted
version and release commands only when intentionally shipping an App Store
production-channel build:

```bash
cd app
yarn version:bump-ota production && yarn update:production
yarn version:bump-build production && yarn build:production
```

OTA is for JavaScript and asset changes only. Use a native build when native
dependencies, Expo plugins, permissions, icons, splash, build profiles, or
native config changed.
