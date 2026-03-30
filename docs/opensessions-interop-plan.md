# opensessions Interop Plan

## Goal

Adopt the useful parts of the opensessions model in aimux without importing its whole runtime or sidebar.

Aimux already differs in one major way:

- tmux is the substrate
- aimux is the orchestrator and metadata/UI layer

That means the right reuse boundary is:

- metadata schema
- watcher model
- agent attention model
- compact session/detail rendering

Not:

- the opensessions server
- the opensessions TUI/sidebar app
- their mux abstraction layer

## Exact opensessions references

The plan below is anchored to these upstream docs:

- README:
  - `opensessions is a sidebar for tmux`
  - built-in watcher coverage
  - programmatic metadata API
  - repo layout
  - https://raw.githubusercontent.com/Ataraxy-Labs/opensessions/main/README.md
- Architecture:
  - four-part split: mux providers, watchers, server, TUI
  - tracker-based state assembly
  - tmux hooks + sidebar handling
  - https://raw.githubusercontent.com/Ataraxy-Labs/opensessions/main/docs/explanation/architecture.md
- Plugin loading:
  - plugin factory shape
  - local plugin loading
  - watcher registration model
  - https://raw.githubusercontent.com/Ataraxy-Labs/opensessions/main/PLUGINS.md
- Contracts:
  - `AgentStatus`
  - `AgentEvent`
  - `AgentWatcher`
  - `AgentWatcherContext`
  - https://raw.githubusercontent.com/Ataraxy-Labs/opensessions/main/CONTRACTS.md
- Programmatic metadata API:
  - `POST /set-status`
  - `POST /set-progress`
  - `POST /log`
  - `POST /clear-log`
  - `POST /notify`
  - https://raw.githubusercontent.com/Ataraxy-Labs/opensessions/main/docs/reference/programmatic-api.md

## What aimux already has

Aimux already has the minimum substrate needed to adopt this model:

- `src/metadata-store.ts`
- `src/metadata-server.ts`
- `src/plugin-runtime.ts`
- `src/builtin-metadata-watchers.ts`
- `src/tmux-statusline.ts`
- tmux as the only runtime backend

So the remaining work is not "add plugin support".
It is "make the plugin/watcher model richer and more opensessions-like".

## Mapping opensessions concepts to aimux

### 1. Watchers

opensessions concept:

- agent-specific watchers emit normalized `AgentEvent`s

aimux mapping:

- built-in watchers and local plugins should emit richer metadata updates into `metadata-store`
- longer term, aimux should add a first-class watcher contract, not just ad hoc file watchers

### 2. Agent tracker / attention model

opensessions concept:

- watchers emit raw events
- a tracker derives session-level state, unseen state, and per-thread status

aimux mapping:

- add an `AgentTracker`-style layer above raw watcher/plugin updates
- derive session-level activity and attention state from:
  - watcher events
  - metadata API events
  - task state
  - local session logs/history

### 3. Programmatic metadata API

opensessions concept:

- small HTTP API for status/progress/logs/notifications

aimux mapping:

- already implemented
- extend it rather than replacing it

### 4. Sidebar/detail UI

opensessions concept:

- compact session list plus richer detail panel

aimux mapping:

- current dashboard right-hand detail pane is the first equivalent
- tmux status bar provides the compact summary layer
- later we can add a dedicated detail/sidebar screen if the dashboard/status bar become too cramped

## What we should not copy directly

- the opensessions Bun server
- the OpenTUI sidebar client
- mux provider abstraction beyond tmux
- their hidden-sidebar tmux stash flow

These are useful design references, but they do not fit aimux's current architecture cleanly.

## Compatibility target

We should make aimux metadata expressive enough that an opensessions-style watcher could map into it cleanly.

That means aimux should support the equivalent of:

- `status`
- `progress`
- `logs`
- `notifications`
- `activity`
- `attention`
- `unseen`
- `threadName`
- `threadId`
- `ports`
- `repo/worktree/branch/pr`

## Proposed aimux metadata extensions

Add normalized metadata fields on top of the current store:

```ts
type AgentActivityState =
  | "idle"
  | "running"
  | "done"
  | "error"
  | "waiting"
  | "interrupted";

type AgentAttentionState =
  | "normal"
  | "unseen"
  | "needs_input"
  | "blocked"
  | "error";

interface AgentInstanceState {
  agent: string;
  threadId?: string;
  threadName?: string;
  status: AgentActivityState;
  ts: number;
  unseen?: boolean;
}

interface SessionDerivedState {
  activity?: AgentActivityState;
  attention?: AgentAttentionState;
  unseenCount?: number;
  needsInput?: boolean;
  blockedReason?: string;
  badges?: string[];
  services?: Array<{ label: string; url?: string; port?: number }>;
}
```

This lets us reproduce most of the opensessions UX without importing its runtime.

## Phase plan

### Phase 1: Agent event model

Introduce a watcher/event contract in aimux:

- `AgentEvent`
- `AgentWatcher`
- `AgentWatcherContext`
- `AgentTracker`

Follow the opensessions shape where it helps:

- watcher emits raw events
- tracker derives session-level state

Files to add:

- `src/agent-events.ts`
- `src/agent-watcher.ts`
- `src/agent-tracker.ts`

### Phase 2: Built-in tool watchers

Port the useful watcher ideas, not necessarily the exact code:

- Claude transcript watcher
- Codex transcript watcher
- maybe OpenCode later

Upstream references:

- Claude watcher behavior:
  - https://raw.githubusercontent.com/Ataraxy-Labs/opensessions/main/CONTRACTS.md
- Codex watcher behavior:
  - same contracts doc
  - plus README examples of transcript locations

Aimux watchers should resolve sessions by:

- worktree/cwd
- tmux window metadata
- session context metadata

### Phase 3: Tracker-derived attention model

Build session-level derived state:

- running
- waiting
- done
- interrupted
- unseen
- needs attention
- needs your input

This is the main thing we want from opensessions in day-to-day use.

### Phase 4: Render that state

Use the tracker-derived state in:

- tmux status bar
- dashboard list
- dashboard details pane

Examples:

- list badges: `done`, `error`, `waiting`, `needs input`
- detail pane:
  - last agent event
  - unseen count
  - active thread name
  - recent notifications/logs

### Phase 5: Optional richer sidebar/details screen

Only if needed later:

- add a dedicated "session detail" or "activity" screen
- or a narrow tmux pane/sidebar

This would be the closest analogue to opensessions' sidebar.

## First concrete features to port

These are the highest-value opensessions features to recreate first:

1. Agent activity state per session
2. Unseen markers for `done`, `error`, `interrupted`
3. Thread name / active task name
4. Attention state like `needs input`
5. Detected localhost ports / service URLs

## What this means for plugins

Plugins should become one of two things:

1. metadata publishers
2. agent watchers

That mirrors opensessions closely enough to preserve future interoperability.

Target plugin API additions:

```ts
registerWatcher(watcher)
metadata.setActivity(session, event)
metadata.setAttention(session, state)
metadata.setServices(session, services)
metadata.clearDerived(session)
```

## Decision

We are not porting opensessions wholesale.

We are:

- adopting its watcher/tracker/attention ideas
- aligning our metadata model so interoperability is possible
- building those features natively into aimux's tmux-backed architecture
