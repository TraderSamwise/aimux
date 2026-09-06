# Aimux Contract Fixtures v1

This directory is the shared fixture root for TypeScript-to-Rust parity tests.
Fixtures here must be consumable by both Vitest and `cargo test`.

Golden updates must be explicit. Use `UPDATE_CONTRACT_GOLDENS=1` only in tests
that intentionally support rewriting expected outputs.

Priority fixture groups:

1. `project-api`: route shapes, mutation invalidations, HTTP/SSE payloads.
2. `core-command`: daemon command names and core HTTP route shapes.
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

## Attachments

- `attachments/text.json`: wrapped attachment text recovery cases captured by
  running TypeScript `recoverWrappedAttachments` against the attachment parser
  test scenarios and wrap-position matrices.

## Backend Session Discovery

- `backend-session-discovery/discovery.json`: Claude/Codex transcript
  discovery, ambiguity handling, transcript relocation, and moved-session argv
  cases captured by running the TypeScript backend discovery helpers against
  temporary transcript stores.

## Coordination

- `coordination/model.json`: coordination inbox, worklist, stale-notification,
  reachability, sorting, and view composition cases captured by running the
  TypeScript coordination model functions.

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

## Runtime Coherence

- `runtime-coherence/report.json`: daemon/project-service/tmux version
  coherence, service reachability, dashboard staleness, runtime contract
  rebuild, supervisor restart, stale native path, and rendered-report cases
  captured by running TypeScript `buildRuntimeCoherenceReport` with mocked
  runtime dependencies.

## Statusline

- `statusline/model.json`: statusline helper, scoped-session, teammate,
  focused-control-session, metadata projection, and semantic badge cases
  captured by running TypeScript `statusline-model` exports.
