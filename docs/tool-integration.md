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

This is currently true for Codex.

This is currently false for Claude:

- Claude accepts `--session-id`
- but the same stored id is not a valid `--resume` target in our observed flows

So Claude is configured with:

- `sessionIdFlag`
- `resumeArgs`
- `resumeByBackendSessionId: false`

That forces aimux to use native fallback behavior instead of a broken backend-id resume path.

## Aimux-Owned Continuity

Because tmux owns the live terminal, aimux cannot rely on the old PTY-recorder model alone.

Aimux now maintains continuity from tmux pane state:

- live pane snapshots backfill `context/<session-id>/live.md`
- when a tool returns to a visible prompt after output, aimux captures a synthetic response snapshot into `history/<session-id>.jsonl`
- migration fallback prefers:
  1. parsed history turns
  2. `live.md`
  3. direct tmux pane capture from the source session

This matters for tools like Claude where native backend resume is not reliable.

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
- `sessionCapture`

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

### Codex

- native backend resume path: yes
- prompt detection: yes
- tmux snapshot continuity: yes
- aimux fallback continuity: yes
- audit note:
  - native resume is the preferred path
  - tmux-backed sessions can still lack structured `history/*.jsonl` or `live.md`, so the pane-snapshot fallback remains important

### Claude

- native backend resume by stored backend id: no
- prompt detection: partly heuristic
- tmux snapshot continuity: yes
- aimux fallback continuity: required
- audit note:
  - raw terminal recordings are not reliable enough to reconstruct turns on their own
  - migration continuity depends on tmux pane snapshots and live-context fallback instead of backend-id resume

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

If backend resume is not real, set `resumeByBackendSessionId: false` and rely on aimux-owned continuity instead of pretending the tool can resume natively.
