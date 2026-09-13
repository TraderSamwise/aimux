# Agent Role System v1

Status: design proposal

Scope: gqaapg-4, gqaapg-10, gqaapg-12

## Context

Aimux already has two role concepts, but neither is quite the system Sam wants:

- `team.json` defines human/team workflow roles such as `coder` and `reviewer`.
- Runtime session metadata has special project-control flags: `overseer`,
  `scribe`, `projectControl`, and legacy `role` / `team.role` values.

The architecture boundary in `docs/architecture.md` is the important constraint:
the project service owns shared project state and lifecycle mutations; tmux owns
terminal mechanics; clients must not become alternate writers. Role and lane
state therefore belongs behind project-service routes and should be exposed to
the dashboard, CLI, web app, and mobile app through the same contracts.

The prompt references `src/team.ts`. That file no longer exists in this
checkout. The current seam is `native/crates/aimux/src/team_contract.rs`, with
client-side mirroring in `app/lib/desktop-state.ts`. The design below builds on
that seam: `is_project_control_session`, `is_overseer_session`,
`is_scribe_session`, and `project_control_display_role` remain compatibility
helpers while the new typed model becomes the source of truth.

## Goals

1. Make `coder` the explicit default role for ordinary agents.
2. Generalize supervisor roles without losing today's useful floating
   overseer/scribe behavior.
3. Introduce a first-class supervisor lane that floats above git surfaces.
4. Allow promotion and demotion between coder and supervisor roles.
5. Bind overseers to watched agents with one overseer per watched agent.
6. Preserve supervisor identity across daemon restart and machine reboot.
7. Give the GUI first-party supervisor-domain access through the normal project
   API and desktop-state contracts.

## Non-Goals For v1

- Multiple overseers watching the same coder.
- Overseers watching non-coder roles.
- Cross-project supervisor identities.
- Moving a running process's current working directory as part of a metadata
  migration.
- Dashboard-only role state.
- Making `team.json` role definitions the runtime identity source.

## Model

There are two orthogonal concepts:

```ts
type AgentRole = "coder" | "overseer" | "scribe" | string;

type AgentLane =
  | { kind: "worktree"; worktreePath: string }
  | { kind: "supervisor" };
```

`role` answers what the agent is. `lane` answers where the product places it.
They usually move together, but they must not be the same field.

### Roles

- `coder` is the explicit default for every normal agent.
- `overseer` and `scribe` are supervisor roles.
- Future non-coder roles can opt into supervisor behavior by declaring
  `supervisor: true` in role metadata.
- `projectControl` becomes a derived compatibility boolean: true for supervisor
  roles, false for ordinary roles, absent only while reading old metadata.

Role behavior:

| Role | Default lane | Identity behavior | Lifecycle default |
| --- | --- | --- | --- |
| `coder` | Worktree lane | Ordinary session identity | Stop stays stopped unless user resumes/restores |
| `overseer` | Supervisor lane | Durable supervisor identity | Always resume by default |
| `scribe` | Supervisor lane | Durable supervisor identity | Always resume by default |
| future supervisor role | Supervisor lane | Durable supervisor identity | Always resume by default |

Supervisor roles are "first-party project agents", not worktree occupants. They
still run from the main checkout in v1, because the current runtime already
does that and it preserves today's floating behavior. The lane changes product
placement and lifecycle identity; it does not pretend there is a separate git
surface.

### Supervisor Lane

The supervisor lane is an explicit placement domain for a project:

- It is not a worktree and has no branch.
- It renders above worktree groups in the TUI dashboard.
- It renders as a top-level sidebar/domain group in the GUI.
- It is included in topology and desktop state as a separate lane, not as a
  hidden main-checkout worktree item.
- Agents in the lane use the main checkout as their working directory unless a
  future role explicitly defines a different launch policy.

The lane should be represented in API output even when empty, so clients can
render a stable supervisor box and affordances such as "start overseer" or
"resume scribe" without inventing local state.

## State Ownership

The project service owns a new durable role registry in the project state dir,
for example:

```text
~/.aimux/projects/<project-id>/agent-role-registry.json
```

Suggested shape:

```json
{
  "version": 1,
  "sessions": {
    "codex-abc123": {
      "role": "overseer",
      "lane": { "kind": "supervisor" },
      "durability": {
        "desired": true,
        "resumePolicy": "always",
        "identityKey": "supervisor:overseer:default",
        "createdAt": "2026-09-13T00:00:00.000Z",
        "updatedAt": "2026-09-13T00:00:00.000Z"
      },
      "watching": ["codex-worker1"]
    }
  },
  "watchBindings": {
    "codex-worker1": "codex-abc123"
  },
  "roleSlots": {
    "supervisor:overseer:default": "codex-abc123",
    "supervisor:scribe:default": "claude-scribe1"
  }
}
```

This registry is the authoritative source for role, lane, durable supervisor
identity, and watch bindings. Runtime topology, tmux metadata, metadata state,
desktop-state, `/agents`, `/topology`, switchable-agents, and statusline expose
projections of it.

The existing `overseer`, `scribe`, `projectControl`, legacy `role`, and
`team.role` fields remain compatibility projections during migration. New code
should read the typed role/lane fields first, then fall back through
`team_contract` for old sessions.

Do not make repo-local `.aimux/context/*` or `.aimux/history/*` the source of
truth. They are continuity artifacts. The role registry may reference transcript
and backend resume identifiers, but managed liveness and desired supervisor
state remain project-service state.

## Durable Supervisor Identity

"The same supervisor" means:

- same logical Aimux session id,
- same role slot, such as `supervisor:overseer:default`,
- same backend session id when the tool supports exact resume,
- same transcript/history/context identity,
- same role/lane/watch metadata,
- possibly a different tmux window id after restart or reboot.

The tmux window id is not identity. It is a runtime location that can be
recreated.

Supervisor roles use `resumePolicy: "always"` by default. If Sam stops a
supervisor or reboots the machine, the project service should attempt to bring
the same logical supervisor back. `/clear` is the explicit action that starts a
fresh conversation for that supervisor slot. `/clear` should create a new
backend/transcript generation while preserving the role slot and lane, unless
the command is explicitly "remove supervisor".

Existing agent-restore rails should be reused for launch/resume mechanics:

- `agent_restore_task` already records last-online agents on the scheduler and
  preserves project-control flags in restore snapshots.
- That machinery should be extended to include typed `role`, `lane`,
  `identityKey`, and supervisor resume metadata.
- It should not become the source of truth for desired supervisors. The role
  registry is authoritative; restore snapshots are evidence used to resume.

## Reconciliation

Supervisor reconciliation belongs on the shared project-service tick loop as a
`PeriodicTask`, with event-driven kicks.

Proposed task: `SupervisorRoleReconciler`.

It should:

1. Run once immediately on project-service startup.
2. Run on a slow cadence as a backstop.
3. Be kicked on role mutation, lifecycle mutation, topology change, and restore
   snapshot updates.
4. Read the role registry, topology, metadata, and live tmux windows.
5. For each desired supervisor slot:
   - if the logical session is live, verify its metadata projection;
   - if tmux is gone but exact resume is available, recreate the window and
     resume the same backend session;
   - if exact resume is blocked, surface `restoreState: "blocked"` with the
     reason rather than creating a different supervisor silently.
6. Log and surface could-not-ask errors instead of treating them as absence.

This follows the existing background-work rule: shared state reconciliation is a
periodic project-service task, not a bare loop. It also keeps the scheduler's
health diagnostics useful for supervisor recovery.

## Migration

Role/lane migration should be a metadata-first mutation with explicit
validation. It should not kill or relaunch a running agent by default.

### Coder To Overseer

1. Caller asks project service to set `role: "overseer"` and lane
   `{ kind: "supervisor" }`.
2. Service verifies the source session is currently a coder.
3. Service removes incompatible coder-only bindings from the source session.
4. Service creates or attaches a supervisor role slot.
5. Service writes the role registry under one mutation lock.
6. Service updates metadata/topology projections.
7. Running process continues in its current tmux pane; dashboard/GUI placement
   changes on the next state refresh.

If the promoted session is in a worktree, v1 does not `cd` it into the main
checkout while running. Its next resume/relaunch uses the supervisor launch
policy and main checkout. The API should expose `runtimeWorkingDirectory` when
it differs from lane placement so clients do not lie.

### Overseer To Coder

Demotion requires an explicit target worktree. The service:

1. Releases or transfers watch bindings.
2. Changes role to `coder`.
3. Changes lane to `{ kind: "worktree", worktreePath }`.
4. Changes durability to ordinary coder defaults.
5. Keeps transcript and session id unless the user separately clears/kills it.

If an overseer has active watch bindings, default demotion should fail with a
409 and list the bindings. The caller can retry with `releaseBindings: true` or
an explicit transfer plan.

### Coder In Supervisor Lane

A regular coder can be moved into the supervisor lane without becoming
project-control. This is useful for a first-party helper that floats above git
surfaces but does not own supervisor permissions. It has `role: "coder"`,
`lane.kind: "supervisor"`, and `projectControl: false`.

This is why lane must not imply role.

## Watch Bindings

The watch graph is project-service-owned state in the role registry:

```ts
type WatchBinding = {
  overseerSessionId: string;
  watchedSessionId: string;
  createdAt: string;
  updatedAt: string;
};
```

Invariant:

- `watchedSessionId` is unique across the graph.
- The watcher role must be `overseer`.
- The watched role must be `coder` in v1.
- The service must prove both sessions exist in readable topology/metadata
  before creating or acting on a binding.
- Could-not-read topology is not "unbound" and not "session absent".

Enforcement belongs in the project service mutation that writes the registry,
not in dashboard or app code. A unique map from watched session id to overseer
session id is the simplest durable representation; the overseer's `watching`
array is a derived convenience or a checked denormalization.

When an overseer is stopped:

- Bindings remain.
- Watched coders show `watchedBy` with `status: "inactive"` or
  `watcherStatus: "stopped"`.
- No other overseer can take the watched coder unless the binding is released
  or transferred.

When an overseer is removed or cleared as a supervisor:

- `clear` preserves the supervisor slot and bindings.
- `remove supervisor` requires either `releaseBindings: true` or
  `transferBindingsTo`.
- The response must name released/transferred bindings.

This preserves Sam's mental model: stopping is temporary, removal changes
ownership.

## Contracts And API

`src/project-api-contract.ts` should grow typed role/lane fields and routes.
`app/lib/api.ts` should re-export and use those same types. The GUI should not
infer supervisor state from labels, session ids, or worktree placement.

Suggested shared fields on agent/session items:

```ts
export type AgentRole = "coder" | "overseer" | "scribe" | string;
export type AgentLane =
  | { kind: "worktree"; worktreePath: string; worktreeName?: string; branch?: string }
  | { kind: "supervisor" };

export interface AgentRoleState {
  role: AgentRole;
  lane: AgentLane;
  projectControl: boolean;
  roleSlot?: string;
  resumePolicy?: "ordinary" | "always";
  watchedBy?: { overseerSessionId: string; status: "active" | "inactive" | "blocked" };
  watching?: Array<{ sessionId: string; status: "active" | "missing" | "blocked" }>;
}
```

Existing response surfaces should include those fields:

- `/agents`
- `/desktop-state`
- `/topology`
- `/control/switchable-agents`
- `/coordination-worklist` when it renders agent rows
- daemon project summaries when they expose agent counts by domain

Suggested mutation routes:

- `POST /agents/role` for role changes.
- `POST /agents/lane` for lane-only migration.
- `POST /agents/watch` to bind/unbind an overseer and coder.
- `POST /supervisors/resume` to explicitly resume a supervisor slot.
- `POST /supervisors/remove` for removal with binding release/transfer.

The existing `/agents/overseer` and `/agents/scribe` routes can remain as
compatibility wrappers over `/agents/role`. They should return the new
`AgentRoleState` as well as the legacy boolean so older clients continue to
work.

Topology should expose a supervisor lane node:

```ts
{
  kind: "lane",
  lane: { "kind": "supervisor" },
  label: "Supervisors",
  agents: 2,
  health: "active"
}
```

Rows under it should be ordinary agent rows with `role`, `lane`,
`projectControl`, `watching`, and `watchedBy` fields.

Desktop state should expose:

```ts
{
  "supervisorLane": {
    "sessions": [],
    "health": "idle"
  },
  "sessions": [],
  "worktreeGroups": []
}
```

During migration, supervisor sessions can remain in `sessions` for
compatibility, but clients should prefer `supervisorLane.sessions` when present.

## Dashboard And GUI Rendering

TUI dashboard:

- Render the supervisor lane as its own box above worktree groups.
- Show overseer/scribe/future supervisor roles there by default.
- Allow coder sessions in the supervisor lane.
- Keep worktree navigation from selecting project-control sessions as worktree
  occupants; select them through the supervisor lane.
- Preserve old filtering while reading legacy `projectControl`, but migrate the
  filtering helper to typed `role/lane` checks.

GUI:

- Add supervisor lane as a first-party sidebar domain, not as a separate
  "team" screen.
- Show role badges and watch relationships from API data.
- Open supervisor agents through the same agent detail/live-pane routes as
  coders.
- Use the same `/desktop-state` or `/agents` resource store as other project
  state so mobile/web do not drift from TUI behavior.

This is how gqaapg-12 falls out of the lane work: the GUI receives a typed
supervisor domain in the normal contracts and renders it alongside worktrees.

## Compatibility Plan

1. Add contract fields while preserving existing booleans.
2. Backfill the role registry from metadata:
   - explicit `overseer: true` -> `role: "overseer"`, supervisor lane;
   - explicit `scribe: true` -> `role: "scribe"`, supervisor lane;
   - explicit demotion flags remain authoritative;
   - no role -> `role: "coder"`, worktree lane if worktree exists.
3. Update `team_contract` to prefer typed role/lane data, then legacy fields.
4. Update launch/resume to write typed data and compatibility fields together.
5. Update clients to render typed data.
6. Later, remove direct caller reliance on `overseer`, `scribe`, and
   `projectControl` booleans once all supported clients use typed roles.

## Error Semantics

This design must follow the three-outcomes rule:

- succeeded with role/lane/watch data,
- succeeded with no matching role/lane/watch data,
- could not read or validate role/lane/watch data.

Could-not-read registry/topology/metadata must not mean:

- no supervisor lane,
- no overseer,
- no watch binding,
- no owner for a tmux window,
- safe to deliver input or mutate a watched session.

Routes that need role proof before an action should fail or block knowingly.
Routes that can degrade should include an unavailable/error field and render
that degradation.

## Tests Required Before Implementation Is Done

Implementation should include mutation-proven tests for:

- default spawn creates `role: "coder"` in a worktree lane;
- default overseer/scribe creation creates supervisor-lane roles;
- restart/reboot reconciliation resumes the same supervisor session id and
  transcript identity;
- `/clear` creates a fresh conversation generation without losing the
  supervisor slot;
- promoting coder to overseer moves the dashboard/desktop placement without
  killing the running pane;
- demoting overseer with bindings fails unless release/transfer is explicit;
- one watched coder cannot be bound to two overseers;
- stopped overseer preserves bindings and blocks competing overseer claims;
- missing/corrupt role registry surfaces could-not-ask instead of empty lane;
- GUI contract includes supervisor lane and app grouping does not infer from
  labels or paths;
- legacy `overseer`/`scribe`/`projectControl` sessions backfill correctly.

Each guard needs both directions: the invalid case fails and the legitimate
absence/no-data path still works.

## Rejected Alternatives

### Keep Overseer And Scribe As Hardcoded Singletons

Rejected because it preserves the current implicit model. Promotion, multiple
future supervisor roles, GUI supervisor access, and durable identity all become
one-off branches again.

### Make Supervisor Lane A Fake Worktree

Rejected because it would encode floating project agents as a git surface. That
would confuse topology, worktree actions, graveyard behavior, and GUI sidebar
semantics.

### Let Lane Imply Role

Rejected because Sam explicitly wants regular coders to be able to migrate into
the supervisor lane. Lane is placement; role is behavior and identity.

### Store Role State Only In Tmux Metadata

Rejected because tmux metadata is runtime location state and window ids change.
Durable supervisor identity has to survive daemon restart and full machine
reboot.

### Store Role State Only In `team.json`

Rejected because `team.json` is role vocabulary/config, not per-session runtime
ownership. It cannot enforce one-overseer-per-watched-agent or preserve a
specific supervisor identity.

### Kill And Relaunch On Every Migration

Rejected for v1 because migration should be safe while Sam is driving. Metadata
placement can change immediately; launch policy takes effect on the next resume
when a working-directory change is actually needed.

### Release Watch Bindings When Overseer Stops

Rejected because stop is reversible. Releasing on stop would allow accidental
double ownership and make supervisor restart lose its obligations.

### Build GUI Supervisor Access Separately

Rejected because it would create another role model. The GUI should render the
same supervisor lane and role fields that TUI/topology expose.

## Open Questions

1. Should v1 allow multiple overseer role slots, or exactly one overseer agent
   with many watched coders? The watch graph supports multiple overseers as
   long as each watched coder has only one. Product defaults can still create
   one.
2. Should `/clear` preserve the same session id or create a new session id in
   the same role slot? The user-facing meaning is "same supervisor, fresh
   conversation"; implementation should choose the option that best matches the
   existing transcript/backend tooling and state it in the contract.
3. Should coder-in-supervisor-lane use ordinary stop semantics or supervisor
   always-resume semantics? This design proposes ordinary semantics unless the
   role is a supervisor role, because lane alone is not role.
4. How should remote shared-chat surfaces expose supervisors? They should not
   gain owner project administration by accident, so this needs a separate
   access-control pass before remote exposure.
