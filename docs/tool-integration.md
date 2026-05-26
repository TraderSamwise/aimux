# Tool Integration

Aimux is tmux-backed. That means future LLM tools need to integrate with two distinct continuity paths:

1. native tool continuity
2. aimux-owned continuity

## Native Tool Continuity

If a tool can resume a prior conversation directly, configure:

- `resumeArgs`
- optionally `sessionIdFlag`
- `resumeByBackendSessionId`

Example:

```json
{
  "command": "codex",
  "args": ["--dangerously-bypass-approvals-and-sandbox"],
  "resumeArgs": ["resume", "{sessionId}"],
  "resumeByBackendSessionId": true
}
```

`resumeByBackendSessionId` must only be `true` if the backend session id tracked by aimux is actually resumable by the tool later.

This is currently true for Codex and for current Claude Code when aimux starts Claude with `--session-id {id}` and restores it with `--resume {id}`.

Targeted dashboard restore must never use non-specific fallbacks such as `--continue` or "resume last". If aimux cannot build an exact backend-id resume command, restore must fail loudly instead of launching a fresh session under an existing aimux id.

## Aimux-Owned Continuity

Because tmux owns the live terminal, aimux cannot rely on the old PTY-recorder model alone.

Aimux now maintains continuity from tmux pane state:

- live pane snapshots backfill `context/<session-id>/live.md`
- when a tool returns to a visible prompt after output, aimux captures a synthetic response snapshot into `history/<session-id>.jsonl`
- `live.md` is a bounded, replaceable working set maintained by aimux, not by the tool itself
- migration fallback prefers:
  1. parsed history turns
  2. `live.md`
  3. direct tmux pane capture from the source session

This remains useful for fork, migration, and tools where native backend resume is not available.

## Fork vs Migrate

Aimux has two continuity-preserving operations above plain session creation:

### Fork

- creates a new session id
- copies and seeds agent-facing continuity artifacts into the new session:
  - `plans/<target>.md`
  - `status/<target>.md`
  - `history/<target>.jsonl`
  - `context/<target>/live.md`
  - `context/<target>/summary.md`
- opens a handoff thread between source and target

Fork is the main path for:

- switching to a different tool
- splitting work into parallel branches
- preserving context while changing role

### Migrate

- preserves the same aimux session id
- prefers native backend resume when available
- otherwise falls back to aimux-owned continuity injection

Migrate is the main path for:

- moving a session between worktrees
- keeping the same identity while changing working directory

These two operations intentionally share the same source continuity snapshot logic, but they do not share the same tool startup behavior.

## Memory Contract

Aimux continuity is intentionally split into three layers:

1. `history/<session-id>.jsonl`
- append-only audit log
- never compacted away

2. `context/<session-id>/live.md`
- current tmux-derived working set
- bounded and replaceable
- optimized for handoff/fork/runtime continuity

3. `context/<session-id>/summary.md`
- compacted derived memory
- lossy by design
- accompanied by:
  - `summary.meta.json`
  - `summary.checkpoints.jsonl`

Compaction must only mutate derived artifacts (`summary*`), never the raw audit log.

## Required Tool Config Surface

Each new tool should define as many of these as it can support:

- `command`
- `args`
- `preambleFlag`
- `resumeArgs`
- `resumeByBackendSessionId`
- `resumeFallback`
- `sessionIdFlag`
- `promptPatterns`
- `turnPatterns`
- `instructionsFile`
- `developerInstructionsConfigKey`

## What A Good Integration Needs

At minimum:

1. prompt detection
- Aimux needs to know when the tool is waiting for input.

2. stable pane identity
- tmux window metadata must include:
  - session id
  - tool
  - role
  - worktree path
  - backend session id when available

3. continuity story
- either:
  - real backend resume
- or:
  - acceptable context handoff from tmux snapshots

4. output shape audit
- check whether pane snapshots are readable enough for:
  - activity detection
  - attention detection
  - snapshot-based context handoff

## Current State

## Startup Instructions

Standing startup instructions should use a model-visible configuration or system/developer prompt channel whenever the tool provides one.

Codex uses `-c developer_instructions=...` for fresh sessions, teammate sessions, forks, and migrations. Aimux also writes a managed block into the configured `instructionsFile` such as `AGENTS.md`; user-authored content outside that block is preserved.

Do not reintroduce Codex startup prompt injection through tmux typing, delayed submits, or `session.write(prompt + "\r")`. Those paths can paste into Codex without actually submitting, especially when Codex collapses a large prompt into `[Pasted Content ...]`.

If the Codex developer-instructions key is disabled with `developerInstructionsConfigKey: null`, aimux does not fall back to prompt injection. It relies on the managed instruction file instead. Verify a local Codex install with `yarn verify:codex-instructions`.

### Codex

- native backend resume path: yes
- prompt detection: yes
- tmux snapshot continuity: yes
- aimux fallback continuity: yes
- clean startup handoff flag: yes, through `developer_instructions`
- audit note:
  - native resume is the preferred path
  - tmux-backed sessions can still lack structured `history/*.jsonl` or `live.md`, so the pane-snapshot fallback remains important
  - `fork` therefore uses:
    - detached tmux spawn
    - seeded `.aimux/context/...` and `.aimux/plans/...` files
    - continuity instructions passed through `developer_instructions`
  - do not assume the managed `AGENTS.md` fallback carries per-session fork/migration context; the config channel is the durable path for that context

### Claude

- native backend resume by stored backend id: yes, when started with aimux-owned `--session-id`
- prompt detection: partly heuristic
- tmux snapshot continuity: yes
- aimux fallback continuity: useful for fork/migration context
- clean startup handoff flag: yes
- audit note:
  - raw terminal recordings are not reliable enough to reconstruct turns on their own
  - targeted restore must use exact `--resume <backendSessionId>` and must not use `--continue`
  - migration/fork continuity still depends on tmux pane snapshots and live-context fallback for cross-worktree/tool context
  - `fork` is cleaner than Codex because the carried-over handoff can be injected through the tool preamble path

## Integration Checklist

When wiring a future tool:

1. verify whether backend ids are truly resumable
2. add prompt patterns
3. add turn patterns if reliable
4. test tmux pane snapshots for readability
5. test:
- fresh session
- return to prompt
- migration to another worktree
- offline resume
- dashboard activity/attention state

If backend resume is not real, set `resumeByBackendSessionId: false` and rely on aimux-owned continuity instead of pretending the tool can resume natively. For targeted dashboard restore, no exact backend resume means no restore; do not fall back to latest-session behavior.

## Contributor Notes

When changing continuity code, verify all three of these separately:

1. fork into Claude
2. fork into Codex
3. migrate for the same tool

Do not assume that fixing one path fixes the others:

- Claude fork uses preamble injection
- Codex fork uses developer instructions plus seeded continuity artifacts
- Codex migrate usually uses native backend resume
- Claude targeted restore uses native backend resume; fork/migrate still use aimux-owned continuity for handoff context

When changing Codex startup instruction code, verify the installed Codex CLI still exposes `developer_instructions` as developer-visible prompt input with `yarn verify:codex-instructions`.

Also keep the ownership boundary clear:

- aimux owns:
  - `history/*.jsonl`
  - `context/*/live.md`
  - `context/*/summary.md`
- agents may update:
  - `plans/*.md`
  - `status/*.md`

Do not move continuity ownership back into tool instructions. Aimux must remain the source of truth for traceable runtime continuity.
