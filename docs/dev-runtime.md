# Development Runtime

Aimux has two CLI lanes:

- `aimux` is the production/local-work command. It uses `~/.aimux` and daemon port `43190`.
- `aimux-dev` is the development command. It uses `~/.aimux-dev` and daemon port `43191`.

Use `aimux-dev` when developing the GUI or daemon so real `aimux` sessions keep running.

## Runtime Isolation

The runtime can be isolated with environment variables:

```sh
AIMUX_HOME=~/.aimux-dev
AIMUX_DAEMON_PORT=43191
AIMUX_DAEMON_HOST=127.0.0.1
```

`aimux-dev` sets those defaults before loading the normal CLI. Explicit environment variables still win:

```sh
AIMUX_HOME=/tmp/aimux-scratch AIMUX_DAEMON_PORT=43201 aimux-dev daemon restart
```

`aimux-dev login` also defaults to the local Expo web app:

```sh
AIMUX_WEB_APP_URL=http://localhost:8081
```

Use the production app instead with:

```sh
AIMUX_WEB_APP_URL=https://aimux.app aimux-dev login
```

Both `aimux` and `aimux-dev` default relay tokens/connections to:

```sh
AIMUX_RELAY_URL=wss://relay.aimux.app
```

Override `AIMUX_RELAY_URL` when testing a preview or local relay.

Repo-local `.aimux/` files still live inside each project checkout. Use a scratch project when testing destructive project workflows.

Runtime-core migration commands are explicit and lane-aware:

```sh
aimux-dev migration audit --project /path/to/scratch-project
aimux-dev migration import --project /path/to/scratch-project
```

`migration audit` is read-only. `migration import` writes only the selected project's state under the active `AIMUX_HOME` lane plus repo-local `.aimux/` files for that project, then records a rollback manifest under `migration-backups/`.

## Local GUI

Run the isolated daemon:

```sh
aimux-dev daemon restart
aimux-dev daemon project-ensure --project /Users/sam/cs/glyde-frontend
```

Run the local web app with Expo HMR:

```sh
cd app
yarn dev:web:local
```

`yarn dev:web:local` disables relay mode and points the web app at:

```sh
http://localhost:43191
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
http://127.0.0.1:43191
```

The Android emulator helper points at:

```sh
http://10.0.2.2:43191
```

The root helper does the build, ensures the dev daemon, and starts the app:

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
EXPO_PUBLIC_AIMUX_DAEMON_URL=http://localhost:43191
EXPO_PUBLIC_AIMUX_RELAY_URL=wss://relay.aimux.app
```

When `EXPO_PUBLIC_AIMUX_CONNECTION_MODE` is unset, Expo development builds default to `local` and production builds default to `relay`.
Relay mode requires `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`; local mode may omit it and uses local-only auth.

## Backend Loop

CLI and daemon code runs from `dist/`, not directly from `src/`.

Use one terminal for TypeScript watch builds:

```sh
yarn dev
```

After backend changes compile, restart the isolated daemon:

```sh
yarn dev:daemon
aimux-dev daemon project-ensure --project /Users/sam/cs/glyde-frontend
```

App changes under `app/` hot reload through Expo. Backend daemon/project-service changes require a restart.

## Cleanup

Stop the dev daemon:

```sh
aimux-dev daemon stop
```

Remove all isolated dev runtime state:

```sh
rm -rf ~/.aimux-dev
```
