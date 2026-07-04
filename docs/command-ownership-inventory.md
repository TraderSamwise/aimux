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

| Command                                                 | Status | Owner  | Notes                                                                                           |
| ------------------------------------------------------- | ------ | ------ | ----------------------------------------------------------------------------------------------- |
| `aimux restart`                                         | `CUT`  | daemon | Uses `/core/restart-text`; orchestrates daemon, services, runtime repair, and dashboard reload. |
| `aimux daemon ensure [--json]`                          | `CUT`  | daemon | Reads daemon health directly or uses `/core/daemon-ensure-text`.                                |
| `aimux daemon status [--json]`                          | `CUT`  | daemon | Uses `/core/daemon-status-text`.                                                                |
| `aimux daemon projects [--json]`                        | `CUT`  | daemon | Uses `/core/daemon-projects-text`.                                                              |
| `aimux daemon project-ensure --project <path> [--json]` | `CUT`  | daemon | Uses `/core/project-ensure-text` with an explicit project payload.                              |
| `aimux host status [--json]`                            | `CUT`  | daemon | Uses `/core/host-status-text` with the current directory as project context.                    |
| `aimux projects list [--json]`                          | `CUT`  | daemon | Uses `/core/projects-list-text`.                                                                |

## Core-Routable But Not Yet Shim-Fast

These commands already have a core CLI path, but the installed command still
spawns Node before reaching it. Each should either become a shell fast path or be
reclassified with a documented reason.

| Command                        | Status    | Target Owner | Next Cut                                                                                   |
| ------------------------------ | --------- | ------------ | ------------------------------------------------------------------------------------------ |
| `aimux remote status [--json]` | `SIDEcar` | daemon       | Move credential/relay summary behind a daemon-owned status route.                          |
| `aimux remote enable`          | `SIDEcar` | daemon       | Move credential mutation and relay connect orchestration behind a daemon command route.    |
| `aimux remote disable`         | `SIDEcar` | daemon       | Move credential mutation and relay disconnect orchestration behind a daemon command route. |

## Normal User Command Families

| Family                                                    | Status      | Target Owner    | Notes                                                                                     |
| --------------------------------------------------------- | ----------- | --------------- | ----------------------------------------------------------------------------------------- |
| `aimux` dashboard entry                                   | `BOOTSTRAP` | daemon + tmux   | May bootstrap/repair, then should attach to tmux-managed dashboard.                       |
| `aimux init`                                              | `BOOTSTRAP` | daemon          | Project registration/setup path; allowed to start the control plane.                      |
| `aimux spawn`, `aimux stop`, `aimux kill`, `aimux fork`   | `LEGACY`    | project service | Lifecycle semantics belong behind project-service APIs; tmux remains execution substrate. |
| `aimux worktree ...`                                      | `LEGACY`    | project service | Worktree and graveyard state should be project-service/API-owned.                         |
| `aimux graveyard ...`                                     | `LEGACY`    | project service | Resurrection/cleanup should use topology-backed project-service routes.                   |
| `aimux thread ...`, `aimux message ...`                   | `LEGACY`    | project service | Exchange/thread workflows should route through project-service contracts.                 |
| `aimux task ...`, `aimux handoff ...`, `aimux review ...` | `LEGACY`    | project service | Workflow mutations should have one exchange-backed API contract.                          |
| `aimux login`, `aimux logout`, `aimux whoami`             | `LEGACY`    | daemon          | Account/session state should be daemon-owned for all clients.                             |
| `aimux remote ...`, `aimux security ...`                  | `SIDEcar`   | daemon          | Some core routing exists; installed no-spawn path is incomplete.                          |

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
