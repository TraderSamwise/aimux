# Aimux Command Ownership Inventory

This inventory is the command-level map for the core-sidecar migration. The
north star is in [core-sidecar-north-star.md](core-sidecar-north-star.md); this
file tracks which command families still violate or satisfy that model.

## Status Labels

- `CUT`: healthy installed path already routes through the long-lived daemon or
  project service without spawning Node.
- `SIDEcar`: routed by the Node launcher through the daemon/project service, but
  the installed shell shim still starts Node before reaching that route.
- `BOOTSTRAP`: allowed to start Node because its purpose is daemon startup,
  stale recovery, install, or explicit repair.
- `TMUX`: terminal-local mechanics; it may use tmux directly, but not as product
  state authority.
- `LEGACY`: still needs an owner cut before it satisfies the north star.
- `INTERNAL`: developer/debug plumbing, not a normal user recovery path.

## Installed Shim Fast Paths

These commands are the only healthy installed paths that currently bypass the
Node launcher when a matching daemon is already running:

| Command                                                 | Status | Owner                    | Notes                                                                                                  |
| ------------------------------------------------------- | ------ | ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `aimux restart`                                         | `CUT`  | daemon                   | Uses `/core/restart-text`; orchestrates daemon, services, runtime repair, and dashboard reload.        |
| `aimux spawn --tool <tool> ...`                         | `CUT`  | daemon + project service | Uses `/core/lifecycle/spawn-text`; daemon ensures the project service, which owns the mutation.        |
| `aimux stop <sessionId> ...`                            | `CUT`  | daemon + project service | Uses `/core/lifecycle/stop-text`; bare `aimux stop` remains project-runtime bootstrap plumbing.        |
| `aimux kill <sessionId> ...`                            | `CUT`  | daemon + project service | Uses `/core/lifecycle/kill-text`; sends agent lifecycle mutation to the project service.               |
| `aimux fork <sourceSessionId> --tool <tool> ...`        | `CUT`  | daemon + project service | Uses `/core/lifecycle/fork-text`; daemon keeps shell transport thin.                                   |
| `aimux worktree ...`                                    | `CUT`  | daemon + project service | Uses `/core/worktree/*-text`; daemon forwards to project-service worktree APIs.                       |
| `aimux graveyard ...`                                   | `CUT`  | daemon + project service | Uses `/core/graveyard/*-text`; daemon forwards to project-service graveyard APIs.                     |
| `aimux daemon ensure [--json]`                          | `CUT`  | daemon                   | Reads daemon health directly or uses `/core/daemon-ensure-text`.                                       |
| `aimux daemon status [--json]`                          | `CUT`  | daemon                   | Uses `/core/daemon-status-text`.                                                                       |
| `aimux daemon projects [--json]`                        | `CUT`  | daemon                   | Uses `/core/daemon-projects-text`.                                                                     |
| `aimux daemon project-ensure --project <path> [--json]` | `CUT`  | daemon                   | Uses `/core/project-ensure-text` with an explicit project payload.                                     |
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
| `aimux spawn`, `aimux stop`, `aimux kill`, `aimux fork`   | `CUT`       | project service | Agent lifecycle commands use daemon text routes to project-service APIs in the healthy installed path. |
| `aimux worktree ...`                                      | `CUT`       | project service | Healthy installed path uses daemon text routes to project-service APIs.                                |
| `aimux graveyard ...`                                     | `CUT`       | project service | Healthy installed path uses daemon text routes to project-service APIs.                                |
| `aimux thread ...`, `aimux message ...`                   | `CUT`       | project service | Exchange/thread commands use daemon text routes to project-service APIs in the healthy installed path. |
| `aimux task ...`, `aimux handoff ...`, `aimux review ...` | `CUT`       | project service | Workflow commands use daemon text routes to project-service APIs in the healthy installed path.        |
| `aimux whoami`, `aimux logout`                            | `CUT`       | daemon          | Installed shim uses daemon text routes; stale daemon falls back to the core CLI.                       |
| `aimux login`, `aimux security unlock`                    | `CUT`       | daemon          | Plain auth commands use daemon text routes; custom auth flags remain bootstrap cleanup.                |
| `aimux remote ...`                                        | `CUT`       | daemon          | Status/enable/disable use daemon text routes from the installed shim.                                  |
| `aimux security ...`                                      | `SIDEcar`   | daemon          | Non-auth security checks still need a cut if they become normal user commands.                         |

## Local Runtime And Developer Plumbing

| Family                                                                  | Status      | Owner                  | Notes                                                                                |
| ----------------------------------------------------------------------- | ----------- | ---------------------- | ------------------------------------------------------------------------------------ |
| `aimux dashboard-reload`                                                | `BOOTSTRAP` | daemon + tmux          | Advanced recovery command; normal users should use `aimux restart`.                  |
| `aimux restart-runtime`                                                 | `BOOTSTRAP` | daemon + tmux          | Advanced runtime repair; normal restart should decide when this is needed.           |
| `aimux repair`                                                          | `BOOTSTRAP` | daemon + tmux          | Internal repair path, not a user decision UI.                                        |
| `aimux host ui`, `host serve`, `host stop`, `host kill`, `host restart` | `INTERNAL`  | daemon                 | Host/service management plumbing.                                                    |
| `aimux host topology`, `host agent-read`, `host agent-stream`           | `SIDEcar`   | project service + tmux | Should become project-service API reads/streams with no direct CLI state writes.     |
| `aimux doctor ...`                                                      | `INTERNAL`  | daemon/project service | Diagnostics should read daemon/project-service reports, not recompute truth locally. |
| `aimux logs ...`                                                        | `INTERNAL`  | daemon/filesystem      | Debug log access; may stay explicitly internal.                                      |
| `aimux metadata ...`                                                    | `INTERNAL`  | project service        | Agent/runtime integration plumbing, not a user-facing state authority.               |
| `aimux team ...`, `aimux loop ...`, `aimux overseer ...`                | `LEGACY`    | project service        | Needs a single topology/exchange-backed owner before broader use.                    |

## Enforcement Rules

- Adding a core-routable command requires adding it to this inventory and to the
  core command disposition test.
- Moving a command to `CUT` requires a healthy installed no-spawn test, stale
  fallback coverage, and output parity for text/JSON modes.
- Keeping a command out of `CUT` requires an explicit `SIDEcar`, `BOOTSTRAP`,
  `TMUX`, `LEGACY`, or `INTERNAL` classification.
- Shell fast paths must stay dumb transport. Complex parsing and semantics
  belong in the daemon or project service.
