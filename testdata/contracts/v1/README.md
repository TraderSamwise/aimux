# Aimux Contract Fixtures v1

This directory is the shared fixture root for TypeScript-to-Rust parity tests.
Fixtures here must be consumable by both Vitest and `cargo test`.

Golden updates must be explicit. Use `UPDATE_CONTRACT_GOLDENS=1` only in tests
that intentionally support rewriting expected outputs.

Priority fixture groups:

1. `project-api`: route shapes, mutation invalidations, HTTP/SSE payloads.
   `project-api/behavior.json` captures route invariants, shared event/view
   names, invalidation groups, and mutation-route invalidation mapping by
   running TypeScript `project-api-contract`.
2. `core-command`: daemon command names and core HTTP route shapes.
   `core-command/behavior.json` captures daemon route responses for ping,
   status, unknown command, and missing-project-root errors by running
   TypeScript `core-command-contract`.
3. `agent-output`: parser fixtures, streaming diffs, liveness transitions.
4. `ansi`: SGR spans and terminal display formatting.
5. `tmux`: command argv, inventory rows, pane captures, statusline artifacts.
6. `project-catalog`: registry, topology, desktop-state project summaries.

## Alerts

- `alerts/display.json`: notification title/body/category/reason
  contextualization cases captured by running TypeScript `alert-display`
  helpers against `src/alert-display.test.ts` scenarios.

## ANSI

- `ansi/sgr-spans.json`: ANSI SGR span cases, including adversarial color,
  reset, inverse, multiline, unsupported-code, and malformed-escape inputs,
  captured by running the TypeScript `app/lib/ansi.ts` parser.

## Agent Output

- `agent-output/activity-text.json`: first-priority progress-line extraction
  cases captured by running TypeScript `activityTextFromParsedAgentOutput`
  against `src/agent-output-activity-text.test.ts` inputs.
- `agent-output/liveness.json`: `readAgentOutput` output/activity/attention
  projections captured by running the TypeScript multiplexer helper with mocked
  pane capture and persisted derived metadata.
- `agent-output/parser-adversarial.json`: golden `{ input, output }` cases
  captured by running the TypeScript `parseAgentOutput` implementation against
  the exported adversarial fixtures, parser fixture tests, compact parser
  tests, harness reads, activity-text inputs, and `src/agent-output-parser.test.ts`
  literals.
- `agent-output/parser-fuzz.json`: frozen deterministic parser fuzz corpus
  captured by running the TypeScript fuzz generator in
  `src/agent-output-parser-fuzz.test.ts`.
- `agent-output/parser-audit.json`: parser audit summaries captured by running
  the TypeScript audit harness in `src/agent-output-parser-audit.test.ts`.
- `agent-output/parser-activity-text.json`: progress/activity text extraction
  cases captured by running TypeScript `activityTextFromParsedAgentOutput`.
- `agent-output/transcript.json`: transcript projection and published
  attachment merge cases captured by running the TypeScript
  `agent-transcript` APIs against `src/agent-transcript.test.ts` inputs.
- `agent-output/tracker.json`: `AgentTracker` event, `markSeen`,
  `setActivity`, `setAttention`, focus-suppression, and derived-count
  transition snapshots captured from the TypeScript metadata store path,
  including one-case-per-event and status-derivation branch coverage.
- `agent-output/bounds.json`: capture-window clamping and end-line contracts
  captured from the TypeScript `agent-output-bounds` helpers.
- `agent-output/stream.json`: SSE text handler output, tail notice, overlap,
  resync, and error contracts captured from the TypeScript stream handler.
- `agent-output/read-metrics.json`: output-read metric aggregation and recent
  ring-buffer behavior captured from the TypeScript metric accumulator.

## Agent Restore

- `agent-restore/state.json`: last-online snapshot, prompt-gate, restore-offer,
  acknowledgement, removal, and reconciliation scenarios captured by running
  TypeScript `runtime-core/agent-restore-state` transitions. Volatile generated
  identifiers and timestamps are normalized after TypeScript execution.

## Agent Status

- `agent-status/chip.json`: status chip mapping and ANSI rendering contracts
  captured by running TypeScript `tui/render/agent-status` helpers.

## Agent Prompt Delivery

- `agent-prompt-delivery/delivery.json`: prompt normalization, visible draft
  detection, pasted-content checks, idle/force/no-draft polling, and submit
  delivery contracts captured by running TypeScript `agent-prompt-delivery`
  helpers.

## Attachments

- `attachments/text.json`: wrapped attachment text recovery cases captured by
  running TypeScript `recoverWrappedAttachments` against the attachment parser
  test scenarios and wrap-position matrices.
- `attachments/store.json`: attachment creation, publishability checks,
  sensitive path classification, hosted metadata, content reads, recent
  publish ordering, and hydration behavior captured by running TypeScript
  attachment-store helpers.

## Backend Session Discovery

- `backend-id-reconcile/reconcile.json`: offline topology backend-session-id
  backfill, transcript ambiguity, existing-id preservation, main-checkout
  fallback, and idempotence behavior captured by running TypeScript
  `reconcileOfflineBackendSessionIds`.
- `backend-session-discovery/discovery.json`: Claude/Codex transcript
  discovery, ambiguity handling, transcript relocation, and moved-session argv
  cases captured by running the TypeScript backend discovery helpers against
  temporary transcript stores.
- `backend-session-ids/identity.json`: strict topology backend-session-id
  latching, topology side effects, full identity resolution, disk-discovery
  fallback, and refusal reasons captured by running TypeScript
  `runtime-core/backend-session-ids`.

## Coordination

- `coordination/model.json`: coordination inbox, worklist, stale-notification,
  reachability, sorting, and view composition cases captured by running the
  TypeScript coordination model functions.

## Notifications

- `notifications/osc.json`: OSC 9, OSC 99, OSC 777, chunk buffering, ST
  terminator, base64, and malformed-payload behavior captured by running the
  TypeScript `OscNotificationParser`.
- `notifications/store.json`: notification list/filter/count, mark-read, clear,
  add/upsert, live alert event, focus-suppression, dedupe, interaction metadata,
  and runtime-exchange side-effect behavior captured by running TypeScript
  notification helpers.
## Operation Failures

- `operation-failures/failures.json`: dashboard operation failure add/list/clear
  persistence, target matching, duplicate replacement, active filtering, and
  side-effect state captured by running TypeScript dashboard operation-failure
  helpers.

## Project Observability

- `project-observability/observability.json`: project summary, task progress,
  story ordering, review tagging, story-limit, and empty-input behavior captured
  by running TypeScript `buildProjectObservability`.

## Context

- `context/compactor.json`: algorithmic summary provenance, metadata, checkpoint
  append behavior, and raw-history preservation captured by running TypeScript
  `context/compactor`.
- `context/bridge.json`: tmux pane live snapshot, bounding, UI-chrome filtering,
  and response-mining behavior captured by running TypeScript `ContextWatcher`.

## Debug State

- `debug-state/report.json`: target resolution, source roles, topology,
  metadata projection filtering, notification matches, worktree graveyard, and
  unavailable live-source contracts captured by running TypeScript
  `buildDebugStateReport`.

## Fast Control

- `fast-control/switching.json`: switchable agent filtering, project-control
  guards, worktree scoping, teammate navigation, liveness handling, and
  serialized item shape captured by running TypeScript `fast-control` helpers.

## Hooks

- `hooks/tool-hooks.json`: Claude and Codex hook command construction,
  merge/install behavior, permission summaries, argument parsing, and payload
  parsing captured by running TypeScript `claude-hooks` and `codex-hooks`
  helpers.

## Install Cleanup

- `install-cleanup/cleanup.json`: install retention planning, reference
  detection, deletion/dry-run behavior, debris reclamation, environment root
  handling, and conservative defaults captured by running TypeScript
  `install-cleanup` helpers.

## Expose

- `expose/pane-output-tap.json`: pane output tap ownership, adoption, renewal,
  pending-start retry, expiry, compaction, lost-ownership, and tmux failure
  cases captured by running TypeScript `ExposePaneOutputTap` with mocked tmux
  calls and temporary tap files.

## Metadata Store

- `metadata-store/store.json`: persisted metadata load/save, topology-owned
  field scrubbing, loop/control-session flags, no-op writes, statusline segment
  replacement/expiry/drop/rejection, and malformed rail cases captured by
  running the TypeScript metadata store against temporary project state.

## Orchestration

- `orchestration/actions.json`: task, handoff, review, thread-reopen, and
  runtime-exchange side-effect contracts captured by running TypeScript
  orchestration action helpers with generated IDs and timestamps normalized
  after structure checks.
- `orchestration/routing.json`: direct, role, tool, worktree, liveness, and
  workflow-pressure recipient routing captured by running TypeScript
  `orchestration-routing` helpers.

## Runtime Coherence

- `runtime-coherence/report.json`: daemon/project-service/tmux version
  coherence, service reachability, dashboard staleness, runtime contract
  rebuild, supervisor restart, stale native path, and rendered-report cases
  captured by running TypeScript `buildRuntimeCoherenceReport` with mocked
  runtime dependencies.

## Runtime Exchange

- `runtime-exchange/alert-routing.json`: message, task assignment, task
  outcome, and review outcome alert recipient routing captured by running
  TypeScript `runtime-core/exchange-alert-routing`.
- `runtime-exchange/import.json`: legacy thread/message/task/file attachment
  conversion, derived handoff/review/wait/inbox references, and absent optional
  directory behavior captured by running TypeScript `runtime-core/exchange-import`.
- `runtime-exchange/store.json`: runtime exchange YAML persistence, mutation
  isolation, external rewrite reads, lock recovery, graph pruning, compaction,
  byte accounting, and diagnostics captured by running TypeScript
  `runtime-core/exchange-store`.

## Recordings

- `recordings/cleanup.json`: recording cleanup retention, live-session guards,
  orphan discovery, size ordering, dry-run/apply/limit behavior, and local
  extra-directory sweeps captured by running TypeScript `recording-cleanup`.
- `recordings/config.json`: global recording cleanup config defaults, off
  switch, minimum retention, and out-of-range fallback captured by running
  TypeScript `recording-config`.

## Event Loop

- `event-loop/budget.json`: event-loop budget thresholds, sync-share rounding,
  insufficient-sample handling, unstarted-monitor failure, and multi-reason
  reporting captured by running TypeScript `event-loop-budget`.
- `event-loop/metrics.json`: event-loop monitor start/stop/not-monitoring
  observations captured by running TypeScript `event-loop-metrics`; the Rust
  fixture is an ignored checklist until the daemon exposes an equivalent
  histogram API.

## Debug

- `debug/lifecycle-log.json`: control-plane lifecycle log writes, daemon-log
  destination, process id presence, and sensitive-field redaction captured by
  running TypeScript `logLifecycleAlways`; the Rust fixture is an ignored
  checklist until the logging subsystem is ported.

## Library

- `library/entries.json`: library stub-plan detection, allowlisted project
  docs, non-stub plans, label projection, recency sorting, frontmatter
  stripping, CRLF parsing, and mtime fallback captured by running TypeScript
  `library`.

## Session

- `session/runtime.json`: SessionRuntime transport data and exit event
  forwarding captured by running TypeScript `session-runtime`.
- `session-bootstrap/action-args.json`: launch action argument stripping and
  launch/persist argument composition captured by running TypeScript
  `session-bootstrap-action-args`.
- `session-bootstrap/preamble.json`: agent instruction text, targeted resume
  argument construction, preamble overflow side effects, and fork/switch/migrate
  continuity preambles captured by running TypeScript `session-bootstrap`.

## Launch

- `launch/managed-env.json`: managed launch environment allowlist, terminal
  normalization, proxy passthrough, extra env injection, and `env -i` wrapper
  behavior captured by running TypeScript `managed-launch-env`.
- `launch/launcher-env.json`: stable CLI targeting environment defaults and
  launcher core/main/expose entry routing captured by running TypeScript
  `launcher-env`.

## Config

- `config/behavior.json`: config layer merging, global/project override rules,
  scribe launch config normalization, expose/worktree defaults, and built-in
  exact-resume migration captured by running TypeScript `config`.
- `install-config/config.json`: global install cleanup config normalization,
  primary-lane detection, and corrupt global config quarantine side effects
  captured by running TypeScript `install-config`.

## CLI

- `cli/parsing.json`: process command-line flag value matching and shell/env
  assignment parsing captured by running TypeScript `process-args` and
  `shell-args`.

## Paths

- `paths/behavior.json`: path identity, runtime-private log/state location, and
  project registry mutation/pruning/failure behavior captured by running
  TypeScript `paths`.

## Daemon Supervisor

- `daemon-supervisor/build-generation.json`: build-stamp generation ordering,
  stale-client error text, and unresponsive daemon keep/restart decisions
  captured by running TypeScript `daemon-supervisor-build-generation`.

## Team

- `team/semantics.json`: orphan teammate selection and project-control session
  classification captured by running TypeScript `team`.

## Proxy

- `proxy/project-binding.json`: proxy path parsing and project-service target
  binding/refusal behavior for live, dead, ambiguous, host-mismatched, pathless,
  null-endpoint, and nonsensical-port candidates captured by running TypeScript
  `proxy-project-binding`.

## Plugin

- `plugin/runtime.json`: plugin alert derivation, bundled default wrapper
  seeding/deletion behavior, failed-start cleanup status, and invalid module
  shape reporting captured by running TypeScript `plugin-runtime`; wrapper and
  startup cases are ignored checklists until the Rust plugin runtime exists.

## Graveyard

- `graveyard/cleanup.json`: graveyard cleanup plan cutoffs, retention
  defaults, callback ordering, dry-run/apply behavior, dependent-agent cleanup,
  and standalone agent asset/state deletion captured by running TypeScript
  `graveyard-cleanup`.

## Runtime Migration

- `runtime-state/atomic-write.json`: atomic text/JSON write, explicit file
  mode, unique temp path, overwrite, and corrupt-file quarantine contracts
  captured by running TypeScript `atomic-write`.
- `runtime-state/service-state-snapshot.json`: runtime-stop service snapshot
  merging, stale compatibility state clearing, topology service demotion, and
  missing-worktree filtering captured by running TypeScript
  `multiplexer/service-state-snapshot`.
- `runtime-state/guard-repair-history.json`: dashboard runtime-guard repair
  attempt persistence, project-key normalization, window pruning, clearing, and
  corrupt-history recovery captured by running TypeScript
  `runtime-guard-repair-history`.
- `runtime-state/last-used.json`: last-used recency ordering, monotonic
  timestamp updates, per-client isolation, pruning, and legacy seeding captured
  by running TypeScript `last-used`.
- `runtime-state/session-recency.json`: user-label recency anchor selection
  captured by running TypeScript `session-recency`.
- `runtime-state/session-restorability.json`: offline-session exact backend
  restore readiness and blocker selection captured by running TypeScript
  `session-restorability`.
- `runtime-state/session-semantics.json`: session semantic labels, attention
  scores, compact hints, notification projection, and display-label precedence
  captured by running TypeScript `session-semantics`.
- `runtime-state/session-viewed.json`: session-viewed metadata attention,
  activity, notification read-state, explicit-project, and config override
  behavior captured by running TypeScript `session-viewed`.
- `runtime-state/drift.json`: local-build drift error classification captured
  by running TypeScript `runtime-drift`.
- `runtime-state/repair-events.json`: durable repair event JSONL logging
  captured by running TypeScript `repair-events`.
- `runtime-migration/migration.json`: report, explicit import, rollback,
  corrupt legacy file, global agent-dir copy avoidance, and blocked existing
  exchange behavior captured by running TypeScript `runtime-migration` helpers
  against temporary repositories.

## Runtime Topology

- `runtime-topology/store.json`: topology store clone/isolation, raw-file
  invalidation, YAML read/write, validation error, lock, and reference-pruning
  behavior captured by running TypeScript `RuntimeTopologyStore`.
- `runtime-topology/sessions.json`: session upsert, graveyard/resurrection,
  replacement save, runtime reconciliation, service preservation, and topology
  reference-pruning behavior captured by running TypeScript
  `runtime-core/topology-sessions`.
- `runtime-topology/services.json`: service upsert, batch update, live tmux
  binding, stopped-service cleanup, and worktree-scoped removal behavior
  captured by running TypeScript `runtime-core/topology-services`.
- `runtime-topology/worktrees.json`: active worktree tracking, graveyard
  movement, deleted graveyard audit entries, resurrection, and active-removal
  behavior captured by running TypeScript `runtime-core/topology-worktrees`.

## Connection Targets

- `connection-targets/targets.json`: CLI and app connection mode, daemon URL,
  relay URL, override, and invalid-mode behavior captured by running TypeScript
  connection-target resolver helpers.

## Statusline

- `statusline/model.json`: statusline helper, scoped-session, teammate,
  focused-control-session, metadata projection, and semantic badge cases
  captured by running TypeScript `statusline-model` exports.

## Transcript

- `transcript/turn-state.json`: Claude/Codex transcript turn-state parsing,
  file-tail reads, transcript probing, and Codex rollout path lookup captured
  by running TypeScript `transcript-turn-state`.

## Worktree

- `worktree/cache-cleanup.json`: generated-cache planning, active-runtime
  protection, dry-run/apply behavior, cleanup-name allowlist, and summarized
  report rendering captured by running TypeScript `worktree-cache-cleanup`
  helpers.

## Work Outline

- `work-outline/outline.json`: work outline upsert, filtering, bounds,
  session-id truncation, and corrupt-state quarantine behavior captured by
  running TypeScript `work-outline` helpers.
