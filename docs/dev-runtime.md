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

## Local GUI

Run the isolated daemon:

```sh
aimux-dev daemon restart
aimux-dev daemon project-ensure --project /Users/sam/cs/glyde-frontend
```

Run the local web app with Expo HMR:

```sh
cd app
yarn dev:local
```

`yarn dev:local` disables relay mode and points the app at:

```sh
http://localhost:43191
```

The root helper does the build, ensures the dev daemon, and starts the app:

```sh
yarn dev:gui
```

To run the local app against the production relay instead:

```sh
cd app
yarn dev:relay
```

or from the repo root:

```sh
yarn dev:gui:relay
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
