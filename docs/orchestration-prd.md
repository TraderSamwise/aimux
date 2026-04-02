# Agent Orchestration PRD

## Status

Mostly implemented.

Implemented so far:

- durable thread/message storage under `.aimux/threads/`
- thread inbox/dashboard screen
- direct messaging, handoff, and task-assignment CLI verbs
- project-service API endpoints for threads, handoffs, task assignment, and workflow actions
- durable message delivery when recipients are busy
- dashboard-native orchestration actions and quick reply/jump flows
- routing by explicit session, role, tool, and worktree
- fan-out routing to all matching recipients
- workflow screen with grouped task/review/revision families
- explicit handoff accept/complete lifecycle
- explicit task accept/block/complete/reopen lifecycle
- explicit review approve/request-changes lifecycle
- workflow filters for actionable states
- main-dashboard workflow pressure badges and next-action hints

Still open:

- richer automation on top of the current verbs
- suggestions / auto-routing on top of the current workflow model
- richer dependency-graph views beyond workflow families
- desktop/UI polish on top of the shipped project-service surface

## Summary

Aimux already has the substrate for multi-agent work:

- tmux-backed live agent runtime
- per-agent plans
- file-backed task dispatch
- shared context/history
- metadata, events, activity, and attention tracking

What it did not yet have at the start of this PRD was a true orchestration layer:

- explicit agent-to-agent messaging
- first-class threads
- request / response / handoff semantics
- durable coordination primitives above raw task files
- clear UI for "who is waiting on whom" and "what needs my attention"

This PRD defined that orchestration layer. Most of the original Phase 1 and Phase 2 goals are now shipped; the remaining work is primarily higher-level automation and visibility polish.

## Problem

Current coordination is split across several mechanisms:

- `.aimux/plans/<session-id>.md` for durable intent
- `.aimux/tasks/*.json` for executable delegation
- `history/*.jsonl` and `context/<session-id>/live.md` for continuity
- metadata/events for derived activity and attention

These are useful, but they do not form a coherent communication model.

Today, if one agent needs something from another, we mostly have:

- task assignment
- shared plan inspection
- implicit context from prior output

Missing are:

- lightweight back-and-forth without creating a full task
- explicit ownership and reply semantics
- thread-local coordination across multiple turns
- visibility into outstanding asks and dependencies
- a clean abstraction for future tool integrations and plugins

## Landscape Review

We should not invent this layer in a vacuum. There are several real systems worth borrowing from.

### 1. opensessions

Reference:

- https://github.com/Ataraxy-Labs/opensessions

Why it matters:

- tmux-first
- watcher-driven agent state
- metadata API
- compact summary + richer detail panel
- unseen / done / error / interrupted state in the UI

What to borrow:

- watcher model
- tracker-derived attention model
- metadata richness
- compact-summary + detail-panel UX

What not to borrow wholesale:

- its full sidebar/runtime/server

License:

- MIT

### 2. AWS CLI Agent Orchestrator (CAO)

Reference:

- https://github.com/awslabs/cli-agent-orchestrator

Why it matters:

- tmux-backed multi-agent orchestration
- explicit orchestration modes
- message routing between live terminals

Key concepts called out in the upstream README:

- `handoff`:
  - synchronous transfer, wait for completion
- `assign`:
  - asynchronous spawn/delegation
- `send_message`:
  - direct communication with an existing agent
- queued delivery when the recipient is busy

Those semantics are extremely close to what aimux needs next.

What to borrow:

- explicit orchestration verbs
- inbox/message delivery semantics
- queued delivery when recipients are busy
- treating terminal identity as a routing target

What not to borrow wholesale:

- their entire server/API stack
- their MCP/server packaging

License:

- Apache-2.0

### 3. multi-agent-coding-system

Reference:

- https://github.com/Danau5tin/multi-agent-coding-system

Why it matters:

- clear orchestrator / explorer / coder role topology
- explicit context-sharing model

What to borrow:

- role separation ideas
- orchestration topology

What not to borrow wholesale:

- its whole execution model or evaluation framing

License:

- Apache-2.0

### 4. OpenAI Swarm

Reference:

- https://github.com/Placester/openai-swarm

Why it matters:

- very clear handoff/routine mental model

What to borrow:

- conceptual handoff semantics

What not to borrow wholesale:

- it is educational, not a product/runtime substrate

License:

- MIT

### 5. GPTSwarm

Reference:

- https://github.com/metauto-ai/GPTSwarm

Why it matters:

- graph-based multi-agent coordination ideas

What to borrow:

- only if we later want graph/planner semantics

What not to borrow now:

- it is too abstract for the immediate local coding-orchestration problem

License:

- MIT

## Borrowing Strategy

Aimux should combine:

- opensessions for watcher/state/UI ideas
- CAO for orchestration verbs and message delivery semantics
- our existing plans/tasks/history/tmux substrate for concrete execution

That means:

- do not import another app wholesale
- do explicitly align our primitives with proven concepts

## Goal

Build a first-class orchestration layer for aimux that supports:

1. direct agent-to-agent requests
2. durable threaded coordination
3. executable delegated tasks
4. explicit attention / waiting / blocked state
5. user visibility into the active dependency graph

## Core Verbs

Aimux should standardize on three top-level orchestration actions, directly inspired by CAO:

1. `send_message`
- lightweight communication with an existing agent
- queued if the target is busy
- ideal for clarification, follow-up, or status checks

2. `assign_task`
- asynchronous delegation of executable work
- built on top of our existing task system
- returns immediately

3. `handoff`
- synchronous transfer / wait-for-result flow
- use when one agent wants another to take the lead and return an answer

These should become explicit concepts in the codebase and UI, even if the initial implementation is file-backed.

## Non-Goals

- Replace tmux runtime ownership
- Build a full chat app UI
- Build a remote networked multi-user collaboration system
- Replace plans or tasks entirely
- Depend on any one LLM vendor's native thread model

## Users

Primary user:

- one human operating a local multi-agent coding workspace

Secondary users:

- plugin/watchers that publish coordination state
- future tool adapters that need a standard orchestration contract

## Design Principles

1. Plans are durable intent.
2. Tasks are executable delegation.
3. Messages/threads are conversational coordination.
4. Context/history are continuity artifacts, not the message bus.
5. Metadata is derived UI state, not the source of truth for orchestration.
6. Every orchestration artifact must survive tmux window switches, dashboard restarts, and worktree migration.

## Existing Infrastructure

Aimux already has these layers:

### 1. Plans

- path: `.aimux/plans/<session-id>.md`
- role:
  - durable intent
  - shared execution notes
  - human-auditable record

### 2. Tasks

- path: `.aimux/tasks/*.json`
- implementation:
  - [`src/tasks.ts`](/Users/sam/cs/aimux/src/tasks.ts)
  - [`src/task-dispatcher.ts`](/Users/sam/cs/aimux/src/task-dispatcher.ts)
- role:
  - assign executable work
  - review loops
  - completion/failure routing

### 3. Context / History

- implementation:
  - [`src/context/history.ts`](/Users/sam/cs/aimux/src/context/history.ts)
  - [`src/context/context-bridge.ts`](/Users/sam/cs/aimux/src/context/context-bridge.ts)
- role:
  - continuity
  - migration handoff
  - cross-session preambles

### 4. Metadata / Events / Tracker

- implementation:
  - [`src/metadata-store.ts`](/Users/sam/cs/aimux/src/metadata-store.ts)
  - [`src/metadata-server.ts`](/Users/sam/cs/aimux/src/metadata-server.ts)
  - [`src/agent-tracker.ts`](/Users/sam/cs/aimux/src/agent-tracker.ts)
- role:
  - status
  - progress
  - activity
  - attention
  - unseen
  - services
  - thread-ish metadata

### 5. Team / Role Routing

- implementation:
  - [`src/team.ts`](/Users/sam/cs/aimux/src/team.ts)
- role:
  - role-aware assignment
  - review topology

## Proposed New Layer

Add an explicit orchestration layer with two new primitives:

1. `messages`
2. `threads`

Tasks remain, but become one specialized orchestration artifact.

More concretely:

- `messages` implement `send_message`
- `tasks` implement `assign_task`
- `handoff` is implemented as a thread + wait semantics on top of the same storage and routing model

## Core Concepts

### Thread

A thread is a durable coordination conversation anchored to:

- one agent
- multiple agents
- a worktree
- a task
- or a user intervention

Threads answer:

- what are we talking about?
- who owns the next response?
- what state is this coordination in?

### Message

A message is one unit in a thread.

Examples:

- request
- reply
- status update
- handoff
- decision
- escalation
- task completion note

Messages should be routable even when the recipient is not currently focused.
If the recipient is busy, delivery can be queued and surfaced through attention state.

### Task

A task remains the mechanism for executable work assignment.

But tasks should optionally reference a thread, so:

- the task carries the execution payload
- the thread carries the surrounding conversation and decisions

This maps cleanly to CAO's `assign` semantics.

### Handoff

A handoff is a thread/task interaction pattern where:

- control or responsibility is transferred to another agent
- the caller explicitly expects a result
- aimux can surface that the caller is waiting on the callee

This maps cleanly to CAO's `handoff` semantics.

## User Stories

### 1. Ask another agent a question without spawning a full task

Example:

- Agent A asks Agent B: "Why did you choose this API shape?"
- Agent B replies in the same thread
- dashboard shows A waiting on B

### 2. Delegate work and keep discussion attached

Example:

- Agent A creates task T for Agent B
- A thread is created or linked automatically
- progress, revisions, and clarifications stay in the same thread

### 3. Resume a migrated agent without losing coordination state

Example:

- Agent migrates from main -> worktree
- thread membership and task linkage survive
- dashboard still shows outstanding asks correctly

### 4. User sees who needs attention and why

Example:

- "Claude in chart-test is blocked waiting on Codex in main"
- "Codex has 2 unseen messages"
- "Reviewer owes a reply in thread X"

## Data Model

### Thread

Proposed file path:

- `.aimux/threads/<thread-id>.json`

Shape:

```ts
interface OrchestrationThread {
  id: string;
  title: string;
  kind: "conversation" | "task" | "review" | "handoff" | "user";
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  participants: string[];
  status: "open" | "waiting" | "blocked" | "done" | "abandoned";
  owner?: string;
  waitingOn?: string[];
  worktreePath?: string;
  taskId?: string;
  relatedPlanIds?: string[];
  lastMessageId?: string;
  unreadBy?: string[];
  tags?: string[];
}
```

### Message

Proposed file path:

- `.aimux/threads/<thread-id>.jsonl`

Shape:

```ts
interface OrchestrationMessage {
  id: string;
  threadId: string;
  ts: string;
  from: string;
  to?: string[];
  kind: "request" | "reply" | "status" | "decision" | "handoff" | "note";
  body: string;
  taskId?: string;
  planId?: string;
  metadata?: Record<string, string | number | boolean | null>;
}
```

### Task linkage

Extend tasks with:

```ts
interface Task {
  threadId?: string;
}
```

## Storage Model

Recommended split:

- repo-local `.aimux/threads/` for durable orchestration artifacts
- global project metadata store for derived/UI state only

Why:

- threads/tasks/plans should travel with the repo/worktree world
- UI-derived state should stay ephemeral/project-local

## API / CLI

Add orchestration commands:

- `aimux thread list`
- `aimux thread show <id>`
- `aimux thread open --title ... --participants ...`
- `aimux thread message <thread-id> --from <session> --to <session> --body ...`
- `aimux thread mark-seen <thread-id> --session <session>`

Add task/thread integration:

- `aimux task create ... --thread <id>`
- auto-create thread when creating a task without one

Add metadata events:

- `thread_opened`
- `thread_message`
- `thread_waiting`
- `thread_blocked`
- `thread_resolved`

## UI

### Dashboard

Add an orchestration-oriented screen or enrich the activity screen with:

- thread summary
- who is waiting on whom
- unread/unseen thread count
- blocked items
- recent replies

Also consider an explicit inbox/thread view later, similar in spirit to opensessions' richer sidebar detail model, but aimux-native.

### Details pane

Selected agent should show:

- active threads
- waiting-on count
- last inbound message
- last outbound message

### Status bar

Compact hints:

- waiting on another agent
- unread thread count
- blocked
- active task/thread badge

## Behavioral Rules

### Ownership

- every open thread has an owner or explicit waiting state
- if waiting on another agent, that should be visible and queryable

### Seen state

- per-session unread/unseen must be tracked at thread level
- `markSeen` should update both metadata and thread unread markers

### Migration

- migrating an agent must preserve:
  - session id
  - thread participation
  - task linkage
  - unread state

### Worktree scoping

- agent-scoped navigation stays worktree-aware
- orchestration views may span worktrees when needed

## Opensessions Alignment

We should explicitly reuse the useful opensessions ideas here:

- watcher-driven events
- tracker-derived attention model
- compact summary + richer details
- programmatic metadata publishing

But aimux keeps its own primitives:

- threads
- tasks
- plans

## CAO Alignment

We should also explicitly align with CAO's orchestration verbs:

- `send_message` -> thread message append + queued delivery
- `assign` -> task creation + async execution
- `handoff` -> thread/task ownership transfer + wait state

This gives aimux a more explicit and proven orchestration vocabulary than "just write files and hope."

OpenSessions-style compatibility target:

- watcher/plugins should be able to emit into:
  - thread events
  - activity/attention state
  - metadata updates

## Implementation Plan

### Phase 1: Thread Store

Add:

- `src/threads.ts`
- file-backed thread + message persistence
- list/read/write/update helpers

Also define explicit orchestration verbs in code:

- `sendMessage(...)`
- `assignTask(...)`
- `handoff(...)`

### Phase 2: Task Integration

Extend `Task` with `threadId`.

When:

- creating a task
- completing a task
- failing a task
- creating a review

emit corresponding thread messages/events.

This is where CAO-style `assign` becomes a first-class concept on top of our existing task system.

### Phase 3: Tracker Integration

Extend metadata/tracker-derived state with:

- active thread count
- unread thread count
- waitingOn sessions
- blockedReason
- inbox count
- waiting-on count
- open handoff count

### Phase 4: Dashboard / Activity UI

Add:

- thread-aware activity rendering
- details pane thread summary
- navigation for unresolved conversations

Phase 4 should make the orchestration state visible even before we build a dedicated inbox screen.

### Phase 5: Tool/Plugin Hooks

Expose plugin API for:

- `openThread(...)`
- `appendMessage(...)`
- `markThreadSeen(...)`
- `linkTaskToThread(...)`

And eventually:

- `setThreadState(...)`
- `publishInboxMessage(...)`

## Success Criteria

We can say this is successful when:

1. agents can ask each other questions without creating fake tasks
2. delegated work has a durable conversation trail
3. dashboard clearly shows waiting / blocked / unread coordination state
4. migration preserves orchestration state
5. future tool integrations can plug into one explicit orchestration contract

## Open Questions

1. Should thread storage be repo-local or global-project-local?
   - recommendation: repo-local `.aimux/threads/`

2. Should every task auto-create a thread?
   - recommendation: yes

3. Should user messages share the same thread system?
   - recommendation: yes

4. Do we want a dedicated thread screen immediately?
   - recommendation: not first; enrich activity/details first
