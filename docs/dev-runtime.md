# Development Runtime

Aimux has one normal CLI lane: `aimux`.

The installed command runs from a frozen local/release bundle under
`~/.aimux/native/`, uses `~/.aimux`, and talks to the local daemon on port
`43190` unless explicitly overridden.

## Backend Loop

CLI, daemon, and project-service code runs from `dist/` inside the installed
bundle. Building this checkout is not enough to change a running install.

For backend changes:

```sh
yarn build
AIMUX_RELEASE_VERSION=local-$(git rev-parse --short HEAD) yarn release:asset
ASSET="$(ls -t release/aimux-*.tar.gz | head -n 1)"
scripts/install.sh "$ASSET"
aimux restart
aimux doctor versions
```

`aimux restart` restarts the daemon, re-ensures known project services, and
reloads existing dashboards without killing agent tmux windows. It also repairs
managed tmux contract drift in place and records automatic repair diagnostics in
`~/.aimux/projects/<project-id>/logs/repairs.jsonl`.

## Local GUI

Run the local web app with Expo HMR:

```sh
aimux daemon ensure
cd app
yarn dev:web:local
```

`yarn dev:web:local` disables relay mode and points the web app at:

```sh
http://localhost:43190
```

Run native dev builds without Expo Go:

```sh
cd app
yarn dev:ios:local
yarn dev:android:local
```

After a native dev build is installed, use Metro-only native HMR:

```sh
cd app
yarn dev:native:local
```

The iOS simulator helper points at:

```sh
http://127.0.0.1:43190
```

The Android emulator helper points at:

```sh
http://10.0.2.2:43190
```

The root helpers ensure the installed daemon and start the app:

```sh
yarn dev:gui
yarn dev:gui:native
yarn dev:gui:ios
yarn dev:gui:android
```

To run the local app against the production relay instead:

```sh
cd app
yarn dev:web:relay
yarn dev:native:relay
yarn dev:ios:relay
yarn dev:android:relay
```

or from the repo root:

```sh
yarn dev:gui:web:relay
yarn dev:gui:native:relay
yarn dev:gui:ios:relay
yarn dev:gui:android:relay
```

The app connection target is controlled with:

```sh
EXPO_PUBLIC_AIMUX_CONNECTION_MODE=local|relay
EXPO_PUBLIC_AIMUX_DAEMON_URL=http://localhost:43190
EXPO_PUBLIC_AIMUX_RELAY_URL=wss://relay.aimux.app
```

When `EXPO_PUBLIC_AIMUX_CONNECTION_MODE` is unset, Expo development builds
default to `local` and production builds default to `relay`. Relay mode requires
`EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`; local mode may omit it and uses local-only
auth.

## Explicit Sandboxes

Use an explicit sandbox only when you really need isolated state:

```sh
AIMUX_HOME=/tmp/aimux-scratch AIMUX_DAEMON_PORT=43201 aimux daemon restart
```

Custom sandboxes are env-var overrides on `aimux`; they are not a second named
CLI workflow. Keep normal development on the installed `aimux` lane so
cross-project views, restart behavior, and version diagnostics all describe one
runtime.

Repo-local `.aimux/` files still live inside each project checkout. Use a
scratch project when testing destructive project workflows.

## Cleanup

Stop the installed daemon:

```sh
aimux daemon stop
```
