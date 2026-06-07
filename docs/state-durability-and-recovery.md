# State Durability And Recovery

How aimux persists authoritative state and recovers it after a crash. Each
invariant below is enforced by a test — the test is the contract, this doc is
the map. If code and this doc disagree, trust the test.

## Authority

Runtime topology (`runtime-topology.yaml`) is the authoritative source for agent
lifecycle and backend identity. Process memory, tmux window metadata, and
`metadata.json` are caches/projections rebuilt from it — they must never be the
only place a durable fact lives.

## Invariants

### Durable writes
All persistent state is written through one crash-safe primitive: stage to a
temp file, `fsync` it, rename into place, then `fsync` the directory.
- Code: `src/atomic-write.ts` (`atomicWrite` / `writeJsonAtomic` / `writeTextAtomic`)
- Used by: the topology and exchange YAML stores, `state.json`, config, team,
  registry, last-used, credentials (`0o600`), service snapshots, attachments.
- Regenerable high-frequency projections (statusline, `live.md`, status text)
  are intentionally left non-fsync'd.
- Test: `src/atomic-write.test.ts`

### Corruption is visible, not silent
A torn/unparseable authority file is moved to `<path>.corrupt-<ts>` and logged,
not silently reset and overwritten.
- Code: `quarantineCorruptFile` in `src/atomic-write.ts`, wired into the readers
  for `state.json`, config, registry, metadata, and the service snapshot.
- Test: `src/atomic-write.test.ts`

### Backend session id is captured durably (go-forward)
When a claude session reports its id, the hook records it into topology so the
agent stays resumable after its tmux pane dies.
- Path: `claude-hook` → `POST /agents/record-backend-session` →
  `recordSessionBackendSessionId` → topology (`src/main.ts`,
  `src/metadata-server.ts`, `src/multiplexer/dashboard-model.ts`,
  `src/multiplexer/runtime-state.ts`).
- Codex carries its id in launch args and needs no hook capture.
- Test: `src/metadata-server.test.ts` ("records backend session ids over HTTP").

### Backend session id is recoverable (after the fact)
If the durable id was lost (crash before capture, or service down), it is
recovered from the tool's own on-disk session store, scoped to the session's
exact worktree so it can never bind an unrelated agent.
- Code: `src/backend-session-discovery.ts`; applied at resume in
  `resumeOfflineSession` and proactively by `reconcileOfflineBackendSessionIds`.
- Tests: `src/backend-session-discovery.test.ts`,
  `src/multiplexer/runtime-state.test.ts`,
  `src/runtime-core/backend-id-reconcile.test.ts`.

## Recovery command

`aimux repair` rebuilds the tmux runtime and backfills missing backend ids for
offline agents from disk. Run it once to recover agents stranded by a crash that
predated the capture fix.

## Proposed (needs sign-off): CLI hierarchy

The command surface has ~80 commands, ~23 flat at the top level, with four
overlapping "fix my runtime" paths and a legacy `host` compat group. A
noun-grouped restructure (`agent …`, `project …`, one `doctor`/recovery surface)
would add direction, but renaming documented verbs (`spawn`, `stop`, `kill`,
`fork`, `worktree`) is churn for users and scripts. This is deliberately left
for explicit sign-off on naming and back-compat rather than done implicitly.
