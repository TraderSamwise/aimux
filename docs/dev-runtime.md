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
