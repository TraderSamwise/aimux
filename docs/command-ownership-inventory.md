# Aimux Command Ownership Inventory

This inventory is the command-level map for the core-sidecar migration. The
north star is in [core-sidecar-north-star.md](core-sidecar-north-star.md); this
file tracks which command families still violate or satisfy that model.

## Status Labels

- `CUT`: healthy installed path already routes through the long-lived daemon or
  project service without spawning Node.
- `SIDECAR`: routed by the Node launcher through the daemon/project service, but
  the installed shell shim still starts Node before reaching that route.
- `BOOTSTRAP`: allowed to start Node because its purpose is daemon startup,
  stale recovery, install, or explicit repair.
- `TMUX`: terminal-local mechanics; it may use tmux directly, but not as product
  state authority.
- `INTERNAL`: developer/debug plumbing, not a normal user recovery path.

## Installed Shim Fast Paths

These commands are the only healthy installed paths that currently bypass the
Node launcher when a matching daemon is already running:

| Command                                                 | Status | Owner                    | Notes                                                                                                  |
| ------------------------------------------------------- | ------ | ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `aimux restart`                                         | `CUT`  | daemon                   | Uses `/core/restart-text`; orchestrates daemon, services, runtime repair, and dashboard reload.        |
| `aimux input <sessionId> <text...>`                     | `CUT`  | daemon + project service | Uses `/core/agents/input-text`; sends agent input through the project-service agent API.               |
| `aimux ps [--json]`                                     | `CUT`  | daemon + project service | Uses `/core/agents/ps-text`; lists agents from the project service without a fresh Node process.       |
| `aimux rename <sessionId> --label <label>`              | `CUT`  | daemon + project service | Uses `/core/agents/rename-text`; label mutation stays project-service owned.                           |
| `aimux migrate <sessionId> --worktree <path>`           | `CUT`  | daemon + project service | Uses `/core/agents/migrate-text`; worktree migration stays project-service owned.                      |
| `aimux spawn --tool <tool> ...`                         | `CUT`  | daemon + project service | Uses `/core/lifecycle/spawn-text`; daemon ensures the project service, which owns the mutation.        |
| `aimux stop <sessionId> ...`                            | `CUT`  | daemon + project service | Uses `/core/lifecycle/stop-text`; bare `aimux stop` remains project-runtime bootstrap plumbing.        |
| `aimux kill <sessionId> ...`                            | `CUT`  | daemon + project service | Uses `/core/lifecycle/kill-text`; sends agent lifecycle mutation to the project service.               |
| `aimux fork <sourceSessionId> --tool <tool> ...`        | `CUT`  | daemon + project service | Uses `/core/lifecycle/fork-text`; daemon keeps shell transport thin.                                   |
| `aimux loop ...`                                        | `CUT`  | daemon + project service | Uses `/core/loop/*-text`; loop membership and exit events stay project-service owned.                  |
| `aimux overseer ...`                                    | `CUT`  | daemon + project service | Uses `/core/overseer/*-text`; overseer spawn/clear goes through project-service agent APIs.            |
| `aimux notify`, `list/read/clear-notifications`         | `CUT`  | daemon + project service | Uses `/core/notifications/*-text`; project service owns notification reads and mutations.              |
| `aimux team ...`                                        | `CUT`  | daemon + project service | Uses `/core/team/*-text`; project service owns role config reads and writes.                           |
| `aimux doctor versions`, `aimux doctor tmux`            | `CUT`  | daemon                   | Uses `/core/doctor/*-text`; diagnostics are computed by the long-lived daemon in the healthy path.     |
| `aimux logs path`, `tail`, `clear`                      | `CUT`  | daemon/filesystem        | Uses `/core/logs/*-text`; diagnostic log access stays local but no longer starts a fresh Node process. |
| `aimux repair ...`                                      | `CUT`  | daemon + tmux            | Uses `/core/repair-text`; explicit repair runs inside the daemon and may focus tmux with `--open`.     |
| `aimux dashboard-reload [--open]`                       | `CUT`  | daemon + caller tmux     | Uses `/core/dashboard-reload-text`; stale daemon fallback may bootstrap, healthy reload stays daemon-owned. |
| `aimux restart-runtime [--project-root <path>]`          | `CUT`  | daemon + tmux            | Uses `/core/runtime-restart-text`; advanced runtime repair is daemon-owned in the healthy path.        |
| `aimux serve`                                           | `CUT`  | daemon                   | Uses `/core/project-serve-text`; ensures the current project service without a fresh Node process.     |
| `aimux host stop`, `host kill`, `host restart [--serve|--open]` | `CUT`  | daemon + caller tmux     | Uses `/core/project-*-text`; daemon owns service lifecycle, caller supplies `--open` focus context.    |
| `aimux worktree ...`                                    | `CUT`  | daemon + project service | Uses `/core/worktree/*-text`; daemon forwards to project-service worktree APIs.                       |
| `aimux graveyard ...`                                   | `CUT`  | daemon + project service | Uses `/core/graveyard/*-text`; daemon forwards to project-service graveyard APIs.                     |
| `aimux daemon ensure [--json]`                          | `CUT`  | daemon                   | Reads daemon health directly or uses `/core/daemon-ensure-text`.                                       |
| `aimux daemon status [--json]`                          | `CUT`  | daemon                   | Uses `/core/daemon-status-text`.                                                                       |
| `aimux daemon projects [--json]`                        | `CUT`  | daemon                   | Uses `/core/daemon-projects-text`.                                                                     |
| `aimux daemon project-ensure --project <path> [--json]` | `CUT`  | daemon                   | Uses `/core/project-ensure-text` with an explicit project payload.                                     |
| `aimux daemon restart [--json]`                         | `CUT`  | daemon                   | Uses `/core/restart-text` as the compatibility alias for `aimux restart`.                              |
| `aimux host status [--json]`                            | `CUT`  | daemon                   | Uses `/core/host-status-text` with the current directory as project context.                           |
| `aimux projects list [--json]`                          | `CUT`  | daemon                   | Uses `/core/projects-list-text`.                                                                       |
| `aimux remote status [--json]`                          | `CUT`  | daemon                   | Uses `/core/remote-status-text`; status JSON never includes credential tokens.                         |
| `aimux remote enable`                                   | `CUT`  | daemon                   | Uses `/core/remote-enable-text`; credential mutation and relay connect are daemon-owned.               |
| `aimux remote disable`                                  | `CUT`  | daemon                   | Uses `/core/remote-disable-text`; credential mutation and relay disconnect are daemon-owned.           |
| `aimux whoami [--json]`                                 | `CUT`  | daemon                   | Uses `/core/whoami-text`; account JSON never includes credential tokens.                               |
| `aimux logout`                                          | `CUT`  | daemon                   | Uses `/core/logout-text`; relay disconnect and credential removal are daemon-owned.                    |
| `aimux login`                                           | `CUT`  | daemon                   | Uses `/core/login-start-text` + `/core/login-wait-text`; daemon owns browser auth and relay reconnect. |
| `aimux security unlock`                                 | `CUT`  | daemon                   | Uses `/core/security-unlock-start-text` + `/core/security-unlock-wait-text`; daemon owns re-auth.      |

## Core-Routable But Not Yet Shim-Fast

No commands currently live in this category.

## Normal User Command Families

| Family                                                    | Status      | Target Owner    | Notes                                                                                                  |
| --------------------------------------------------------- | ----------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| `aimux` dashboard entry                                   | `BOOTSTRAP` | daemon + tmux   | May bootstrap/repair, then should attach to tmux-managed dashboard.                                    |
| `aimux init`                                              | `BOOTSTRAP` | daemon          | Project registration/setup path; allowed to start the control plane.                                   |
| `aimux input`, `aimux ps`, `aimux rename`, `aimux migrate` | `CUT`       | project service | Agent utility commands use daemon text routes to project-service APIs in the healthy installed path.   |
| `aimux spawn`, `aimux stop`, `aimux kill`, `aimux fork`   | `CUT`       | project service | Agent lifecycle commands use daemon text routes to project-service APIs in the healthy installed path. |
| `aimux worktree ...`                                      | `CUT`       | project service | Healthy installed path uses daemon text routes to project-service APIs.                                |
| `aimux graveyard ...`                                     | `CUT`       | project service | Healthy installed path uses daemon text routes to project-service APIs.                                |
| `aimux thread ...`, `aimux message ...`                   | `CUT`       | project service | Exchange/thread commands use daemon text routes to project-service APIs in the healthy installed path. |
| `aimux task ...`, `aimux handoff ...`, `aimux review ...` | `CUT`       | project service | Workflow commands use daemon text routes to project-service APIs in the healthy installed path.        |
| `aimux loop ...`, `aimux overseer ...`                    | `CUT`       | project service | Healthy installed path uses daemon text routes to project-service agent APIs.                          |
| `aimux notify`, `list/read/clear-notifications`           | `CUT`       | project service | Healthy installed path uses daemon text routes to project-service notification APIs.                   |
| `aimux team ...`                                          | `CUT`       | project service | Team role config is read and written by project-service team APIs.                                     |
| `aimux whoami`, `aimux logout`                            | `CUT`       | daemon          | Installed shim uses daemon text routes; stale daemon falls back to the core CLI.                       |
| `aimux login`, `aimux security unlock`                    | `CUT`       | daemon          | Plain auth commands use daemon text routes; custom auth flags remain bootstrap cleanup.                |
| `aimux remote ...`                                        | `CUT`       | daemon          | Status/enable/disable use daemon text routes from the installed shim.                                  |
| `aimux doctor versions`, `aimux doctor tmux`, `aimux repair` | `CUT`       | daemon + tmux   | Healthy installed diagnostics/repair run inside the daemon; stale daemon falls back to bootstrap.      |
| `aimux logs path`, `tail`, `clear`                        | `CUT`       | daemon/filesystem | Healthy installed diagnostic log access uses daemon text routes; stale daemon falls back to bootstrap. |
| `aimux serve`, `aimux host stop/kill/restart`              | `CUT`       | daemon          | Project-service management uses daemon text routes in the healthy installed path.                      |
| `aimux dashboard-reload`, `aimux restart-runtime`          | `CUT`       | daemon + tmux   | Advanced dashboard/runtime repair commands use daemon text routes in the healthy installed path.       |

## Local Runtime And Developer Plumbing

| Family                                                                  | Status      | Owner                  | Notes                                                                                |
| ----------------------------------------------------------------------- | ----------- | ---------------------- | ------------------------------------------------------------------------------------ |
| `aimux dashboard-reload`                                                | `CUT`       | daemon + caller tmux   | Advanced recovery command uses `/core/dashboard-reload-text`; normal users should use `aimux restart`. |
| `aimux restart-runtime`                                                 | `CUT`       | daemon + tmux          | Advanced runtime repair uses `/core/runtime-restart-text`; normal restart should decide when needed.   |
| `aimux repair`                                                          | `CUT`       | daemon + tmux          | Explicit advanced repair uses `/core/repair-text`; stale daemon fallback may bootstrap.               |
| `aimux host ui`, `host serve`                                           | `INTERNAL`  | daemon                 | Developer service entrypoints; not normal user recovery commands.                    |
| `aimux host stop`, `host kill`, `host restart [--serve|--open]`          | `CUT`       | daemon + caller tmux   | Healthy installed path uses `/core/project-*-text`; `--open` sends caller tmux context to the daemon. |
| `aimux host agent-read`                                                | `CUT`       | project service + tmux | Healthy installed path uses daemon text routes to project-service live-pane output.  |
| `aimux host agent-stream`                                              | `CUT`       | project service + tmux | Healthy installed path uses daemon stream text route to project-service SSE output.  |
| `aimux host topology`                                                  | `INTERNAL`  | tmux/debug             | Debug topology file inspection; not a normal product-state command.                  |
| `aimux doctor versions`, `aimux doctor tmux`                            | `CUT`       | daemon/project service | Healthy installed diagnostics use daemon text routes instead of local CLI recompute. |
| `aimux doctor notifications`                                            | `INTERNAL`  | desktop notifier        | Desktop notification diagnostic remains local debug plumbing.                        |
| `aimux notifications test`                                              | `INTERNAL`  | desktop notifier        | Desktop delivery diagnostic; not a normal project-state command.                    |
| `aimux logs ...`                                                        | `CUT`       | daemon/filesystem      | Healthy installed diagnostic log access uses `/core/logs/*-text`.                    |
| `aimux metadata ...`                                                    | `CUT`       | daemon/project service | Agent/runtime integration plumbing uses `/core/metadata-text` to avoid one-shot Node. |

## Enforcement Rules

- Adding a core-routable command requires adding it to this inventory and to the
  core command disposition test.
- Moving a command to `CUT` requires a healthy installed no-spawn test, stale
  fallback coverage, and output parity for text/JSON modes.
- Invalid or unsupported arguments for a recognized `CUT` command must fail in
  the shim without spawning Node when a matching daemon is healthy.
- Keeping a command out of `CUT` requires an explicit `SIDECAR`, `BOOTSTRAP`,
  `TMUX`, or `INTERNAL` classification.
- Shell fast paths must stay dumb transport. Complex parsing and semantics
  belong in the daemon or project service.
