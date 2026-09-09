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
   `project-api/refresh.json` captures serialized project API refresh
   coalescing timelines by running TypeScript
   `createSerializedProjectApiRefresh` with deferred refresh callbacks.
2. `core-command`: daemon command names and core HTTP route shapes.
   `core-command/behavior.json` captures daemon route responses for ping,
   status, unknown command, and missing-project-root errors by running
   TypeScript `core-command-contract`.
   `core-command/ownership.json` captures core CLI command ownership,
   dispatch classification, and installed-shim route retirement by running
   TypeScript `isCoreCliCommand` and source inventory checks.
3. `agent-output`: parser fixtures, streaming diffs, liveness transitions.
4. `ansi`: SGR spans and terminal display formatting.
5. `tmux`: command argv, inventory rows, pane captures, statusline artifacts.
6. `project-catalog`: registry, topology, desktop-state project summaries.

## Alerts

- `alerts/display.json`: notification title/body/category/reason
  contextualization cases captured by running TypeScript `alert-display`
  helpers against `src/alert-display.test.ts` scenarios.

## Dashboard

- `dashboard/command-spec.json`: dashboard tmux launch command wrapping,
  environment allowlist, shell quoting, cleanup traps, and build-stamp
  relationships captured by running TypeScript `getDashboardCommandSpec`.
- `dashboard/desktop-state-golden.json`: runtime-light/runtime-full desktop
  state snapshots and snapshot cost model captured by running TypeScript
  `buildDesktopStateSnapshot`.
- `dashboard/desktop-state-counts.json`: hidden-offline count and visible row
  projection behavior captured by running the TypeScript dashboard visibility
  helpers used by `renderDashboard`.
- `dashboard/targets.json`: dashboard target discovery/replacement return
  values and mocked tmux side-effect call logs captured by running TypeScript
  `findLiveDashboardTarget` and `resolveDashboardTarget`.

## Daemon

- `daemon/projects-route-counts.json`: online desktop-agent count behavior
  captured by running TypeScript `countOnlineDesktopAgents`.

## ANSI

- `ansi/sgr-spans.json`: ANSI SGR span cases, including adversarial color,
  reset, inverse, multiline, unsupported-code, and malformed-escape inputs,
  captured by running the TypeScript `app/lib/ansi.ts` parser.

## App Display

- `app-display/status-activity.json`: app status-tone and activity-label
  mapping, status urgency, native colors, command-token, stale spinner, and
  shimmer behavior captured by running TypeScript `app/lib/status-tone` and
  `app/lib/activity-label` helpers.

## App Interaction

- `app-interaction/lifecycle-scroll.json`: app session resume affordance and
  chat scroll policy thresholds, distance math, user-scroll intent, and
  auto-scroll command behavior captured by running TypeScript
  `app/lib/agent-lifecycle` and `app/lib/chat-scroll-policy` helpers.

## App Navigation

- `app-navigation/navigation.json`: initial main route selection, main tab
  href/path mapping, public/internal route separation, and project picker
  online-agent filtering captured by running TypeScript `app/lib/initial-main-route`,
  `app/lib/main-tabs`, and `app/lib/project-picker` helpers.

## App State

- `app-state/helpers.json`: chat transcript loading visibility, native pinned
  offset, terminal output hydration, visible-pane output mode, and active
  shared-session mapping/equality/merge/hydration behavior captured by running
  TypeScript app state helpers.
- `app-state/global-inbox.json`: app global inbox request-key shape/sequence
  and failed-project row retention captured by running TypeScript global inbox
  helpers, with random request scope normalized after execution.
- `app-state/lifecycle-transitions.json`: app project lifecycle transition
  local/failure record normalization and optimistic desktop-state projection
  captured by running TypeScript lifecycle transition helpers.
- `app-state/project-views.json`: app project API view registry, refresh
  dependency expansion, and update-channel routing captured by running
  TypeScript project view helpers.
- `app-state/project-store.json`: app project store empty observability model,
  plan key shape, request-scope matching, and request-key construction captured
  by running TypeScript project store helpers, with random request scope
  normalized after execution.
- `app-state/settings.json`: durable app settings defaults, persisted-settings
  normalization, monitor viewport clamping, share normalization, and desktop
  zoom helpers captured by running TypeScript settings helpers.

## App Runtime

- `app-runtime/projection.json`: app runtime brand selection and OpenRig-style
  project/worktree/agent/service topology projection captured by running
  TypeScript `runtime-brand` and `openrig-topology` helpers.

## CLI

- `cli/agent-id.json`: CLI agent identity payload and text renderer behavior
  captured by running TypeScript `cli/agent-id` helpers.
- `cli/agent-list.json`: CLI agent inventory flat and worktree-grouped text
  renderer behavior captured by running TypeScript `cli/agent-list` helpers.
- `cli/attachment.json`: CLI attachment MIME and relay URL helper behavior
  captured by running TypeScript `cli/attachment` helpers.
- `cli/project-service.json`: CLI project-service resolved-path matching,
  pid extraction, and stale-build help text captured by running TypeScript
  `cli/project-service` helpers.
- `cli/team.json`: CLI team payload and text renderer behavior captured by
  running TypeScript `cli/team` helpers.

## Agent Output

- `agent-display/labels.json`: app generated-label detection, tool-name
  fallback, role-label trimming, short-name, and compact-identity behavior
  captured by running TypeScript `app/lib/agent-display` helpers.
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
- `agent-output/transcript-reconciler.json`: stuck-activity settlement,
  stranded `needs_response` clearing, Codex transcript path caching, and miss
  backoff behavior captured by running TypeScript `TranscriptReconciler`.
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

- `coordination/loop-watcher.json`: loop candidate selection, overseer
  briefing templating, scan cooldown, auto-nudge, and failed-send retry
  behavior captured by running TypeScript `loop-watcher` helpers.
- `coordination/mutations.json`: thread-helper and direct-message mutation
  contracts captured by running TypeScript `threads` and `orchestration`
  helpers, including runtime-exchange side effects. Current Rust route parity
  covers the orchestration cases; direct `threads` helper cases remain a
  checklist until a Rust public API exists.
- `coordination/model.json`: coordination inbox, worklist, stale-notification,
  reachability, sorting, and view composition cases captured by running the
  TypeScript coordination model functions.
- `coordination/scribe-watcher.json`: scribe candidate selection, readiness
  gates, bounded output reads, briefing construction, fingerprint cooldown,
  stopped-scan delivery suppression, and active-candidate pruning captured by
  running TypeScript `scribe-watcher` helpers.
- `coordination/tasks-threads.json`: task compatibility filters, review-status
  normalization, thread summaries, latest-message selection, message grouping,
  and bounded message snapshots captured by running TypeScript `tasks` and
  `threads` helpers.

## Composer

- `composer/protocol.json`: app composer draft normalization, key submission,
  send gating, failure copy, ack text normalization, long prompt fragment
  matching, baseline handling, and attachment acknowledgement behavior captured
  by running TypeScript `app/lib/composer-protocol` helpers.

## Daemon State

- `daemon-state/state.json`: daemon state filtering, fallback, and daemon
  host/port environment contracts captured by running TypeScript `daemon-state`
  helpers.

## Desktop Notifier

- `desktop-notifier/notifier.json`: macOS helper candidate selection, transport
  routing, diagnostic delivery, doctor-report construction and rendering, and
  side-effect call records captured by running TypeScript `desktop-notifier`
  helpers with mocked dependencies.

## Notifications

- `notifications/policy.json`: app notification policy session snapshots, agent
  transitions, daemon record mapping, live alert mapping, stale filtering,
  category gates, dedupe keys, targets, and batch observation captured by
  running TypeScript `app/lib/notification-policy` helpers with `Date.now`
  fixed.
- `notifications/osc.json`: OSC 9, OSC 99, OSC 777, chunk buffering, ST
  terminator, base64, and malformed-payload behavior captured by running the
  TypeScript `OscNotificationParser`.
- `notifications/mobile-push.json`: mobile push alert forwarding request shape
  and external-notification disable gates captured by running TypeScript
  `mobile-push-bridge` against a local daemon endpoint.
- `notifications/notify-alert.json`: notifyAlert category gates, focus
  suppression, external-notification guard, and desktop delivery payloads
  captured by running TypeScript notify with config/suppression/desktop
  recorders.
- `notifications/store.json`: notification list/filter/count, mark-read, clear,
  add/upsert, live alert event, focus-suppression, dedupe, interaction metadata,
  and runtime-exchange side-effect behavior captured by running TypeScript
  notification helpers.
- `notifications/inbox-cleanup-runtime.json`: dashboard inbox cleanup runtime
  refresh/notify/render side effects and post-cleanup notification snapshots
  captured by running TypeScript `persistenceMethods.cleanupInbox`.

## Operation Failures

- `operation-failures/failures.json`: dashboard operation failure add/list/clear
  persistence, target matching, duplicate replacement, active filtering, and
  side-effect state captured by running TypeScript dashboard operation-failure
  helpers.

## Project Observability

- `project-observability/observability.json`: project summary, task progress,
  story ordering, review tagging, story-limit, and empty-input behavior captured
  by running TypeScript `buildProjectObservability`.

## Project Catalog

- `project-catalog/scanner.json`: project scanner status-headline,
  statusline-enrichment, desktop filtering, dashboard-session-name, and
  discovery contracts captured by running TypeScript `project-scanner` helpers
  with a temporary `AIMUX_HOME`. This is currently a Rust checklist corpus
  because there is no public scanner API outside the daemon/project catalog
  implementation.
- `project-catalog/registry.json`: registered project discovery, desktop
  filtering, and dashboard session-name contracts captured by running
  TypeScript `project-scanner` registry helpers with a temporary `AIMUX_HOME`.

## Project Connection

- `project-connection/display.json`: app project endpoint labels,
  project-state error copy, relay discovery gates, and relay-unavailable copy
  captured by running TypeScript `app/lib/project-connection-display` helpers.

## Process

- `process/inspector.json`: process args, process-list, cwd, exited-state, and
  project-service identity contracts captured by running TypeScript
  `process-inspector` helpers against fake `ps`/`lsof` commands.

## Prompt Context

- `prompt-context/context.json`: prompt context normalization, delimiter and
  zero-width bypass neutralization, byte counting, composition, TTL expiry,
  per-session replacement/clear, and expired-entry sweeping captured by running
  TypeScript `prompt-context` helpers.

## Request Errors

- `request-errors/classification.json`: app request-error message extraction and
  transient disconnect classification captured by running TypeScript
  `app/lib/request-errors` helpers.

## Release

- `release/asset.json`: release asset shell packaging checks for Rust CLI
  build/copy/chmod, build-stamp native-artifact coherence, and Node payload
  exclusion captured by evaluating the TypeScript release-asset contract.
- `release/installed-shim.json`: installed shell shim delegation to
  `AIMUX_NATIVE_BIN`, native binary resolution from `AIMUX_ROOT`, and
  missing-binary failure behavior captured by running the shim.
- `release/package-manifest.json`: package `files` allowlist for installed
  runtime scripts/native assets and retired Node payload exclusions captured by
  evaluating the TypeScript package-manifest contract.
- `release/version.json`: installed artifact `VERSION` and `BUILD_PROFILE`
  label precedence plus source-checkout fallback behavior captured by running
  TypeScript version/build-profile helpers.

## Relay

- `relay/client.json`: RelayClient missing-WebSocket status, auth-failure
  notification, security-event notification routing, and project-event SSE
  forwarding behavior captured by running TypeScript `RelayClient` with a
  notify-module recorder.

## Project Topology

- `project-topology/topology.json`: project topology health, rollup, worktree
  view, flattened-row, and count contracts captured by running TypeScript
  `project-topology` helpers.

## Push Registration

- `push-registration/url.json`: app security push registration/test URL
  construction, relay protocol conversion, shared relay context query params,
  trimming, and partial-context errors captured by running TypeScript
  `app/lib/push-registration-url` helpers.

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

## Error Display

- `error-display/display.json`: user-facing error redaction, tmux failure
  collapsing, multiline filtering, line-count caps, and truncation captured by
  running TypeScript `error-display` helpers.

## Fast Control

- `fast-control/switching.json`: switchable agent filtering, project-control
  guards, worktree scoping, teammate navigation, liveness handling, and
  serialized item shape captured by running TypeScript `fast-control` helpers.

## Hooks

- `hooks/tool-hooks.json`: Claude and Codex hook command construction,
  merge/install behavior, permission summaries, argument parsing, and payload
  parsing captured by running TypeScript `claude-hooks` and `codex-hooks`
  helpers.

## Hosted

- `hosted/audit.json`: hosted audit JSONL append, prompt-body side file,
  pending sidecar visibility/recovery, retention pruning, and rotated-file
  pruning behavior captured by running TypeScript hosted-audit helpers.
- `hosted/auth.json`: hosted trusted-header stripping, bearer-token parsing,
  and live/missing/unknown/revoked token authentication behavior captured by
  running TypeScript hosted-auth helpers, with generated principal identities
  normalized after execution.
- `hosted/config.json`: hosted configuration normalization, global/project
  config loading boundaries, startup validation, forwarded-header allowlist,
  and retention behavior captured by running TypeScript hosted-config helpers.
- `hosted/events.json`: hosted client-address selection, device fingerprinting,
  device-sighting state side effects, webhook signing, retry, and disabled
  delivery behavior captured by running TypeScript hosted-events helpers.
- `hosted/lockdown.json`: hosted lockdown marker/cache behavior and hosted
  outbox drain/torn-line/CLI-audit side effects captured by running TypeScript
  hosted-lockdown and hosted-outbox helpers, with lockdown timestamps normalized
  after execution.
- `hosted/principals.json`: hosted principal token, hash, file mode, grant,
  revoke, last-seen, active-count, lock, malformed-store, and corrupt-store
  behavior captured by running TypeScript hosted-principals helpers, with
  generated principal identities normalized after execution.
- `hosted/rate-limit.json`: hosted per-principal request, concurrency,
  idle-prune, and byte-budget limiter behavior captured by running TypeScript
  `HostedRateLimiter`.

## Integration

- `integration/src-surfaces.json`: final uncovered `src` integration surface
  slices captured by running TypeScript `runCoreCli`, `CoreProjectActor`,
  `AimuxDaemon.routeRequest`, hosted listener HTTP requests, and
  `MetadataServer` HTTP/interaction endpoints with nondeterministic ports, PIDs,
  timestamps, build stamps, request IDs, and temp paths normalized after
  execution.

## Install Cleanup

- `install-cleanup/cleanup.json`: install retention planning, reference
  detection, deletion/dry-run behavior, debris reclamation, environment root
  handling, and conservative defaults captured by running TypeScript
  `install-cleanup` helpers.
- `install-cleanup/doctor.json`: install cleanup dry-run guard and report text
  renderer behavior captured by running TypeScript `install-doctor` helpers.

## Interaction Requests

- `interaction-requests/registry.json`: in-memory interaction request
  registration, dedupe, pending filters, resolve/cancel, immediate wait, and
  timeout behavior captured by running TypeScript `InteractionRegistry` with
  generated IDs and timestamps normalized.

## Monitor

- `monitor/capture.json`: app monitor capture filename, base64 stripping,
  decoded-size estimation, and sample text formatting behavior captured by
  running TypeScript `app/lib/monitor-capture` helpers.
- `monitor/targets.json`: app monitor project/shared target filtering,
  generated-label presentation, persisted settings matching, target labels, and
  stable target id behavior captured by running TypeScript
  `app/lib/monitor-targets` helpers.

## Expose

- `expose/control.json`: global expose-control project/session flattening,
  project-name ordering, session-root normalization, and list-failure handling
  captured by running TypeScript `listAllProjectsExposeItems` with deterministic
  dependency doubles.
- `expose/popup-options.json`: popup expose CLI option-to-runtime option
  mapping and path resolution captured by running TypeScript `toExposeOptions`,
  with cwd-dependent paths normalized.
- `expose/pane-output-tap.json`: pane output tap ownership, adoption, renewal,
  pending-start retry, expiry, compaction, lost-ownership, and tmux failure
  cases captured by running TypeScript `ExposePaneOutputTap` with mocked tmux
  calls and temporary tap files.
- `expose/preview-cache.json`: expose preview cache tracked-target, snapshot,
  capture-failure, in-flight, demand-expiry, and global registry behavior
  captured by running TypeScript `ExposePreviewCache` with mocked tmux capture.
- `expose/preview-crop.json`: expose preview footer crop thresholds and
  line-window behavior captured by running TypeScript expose-preview-crop
  helpers.

## Metadata CLI

- `metadata-cli/routing.json`: runtime metadata CLI command parsing, option
  terminator handling, project-service route mapping, and malformed-command
  errors captured by running TypeScript `parseRuntimeMetadataCliArgs`.

## Metadata Server

- `metadata-server/agent-input.json`: shared-chat actor parsing, safe actor
  labels, prompt prefixing, attachment-reference formatting, and hosted
  attachment reference parsing captured by running TypeScript metadata-server
  agent-input helpers.
- `metadata-server/dashboard-client-state.json`: dashboard client control-screen
  parsing captured by running TypeScript `parseDashboardControlScreen`.
- `metadata-server/expose-socket.json`: expose socket positive header integer
  parsing and fixed-size launch-header splitting captured by running TypeScript
  expose-socket helpers.
- `metadata-server/http.json`: JSON body reading, header normalization, CORS
  selection, JSON response sending, and integer parser behavior captured by
  running TypeScript metadata-server HTTP helpers.
- `metadata-server/interaction-display.json`: interaction title, message, and
  summary projection behavior captured by running TypeScript
  `summarizeInteractionForDisplay`.
- `metadata-server/library-documents.json`: library document allowlist,
  metadata, bounded content, and truncation behavior captured by running
  TypeScript `listLibraryDocuments` against a temporary project.
- `metadata-server/lifecycle-mutation-queue.json`: lifecycle mutation queue
  ordering, diagnostics, conflict, queue-limit, error, `lifecycleOk`, and early
  result behavior captured by running TypeScript, with generated operation IDs,
  timestamps, durations, and process IDs normalized after execution.
- `metadata-server/output-previews.json`: expose preview snapshot merging,
  agent-output read coalescing, visual client lease touch behavior, and default
  preview diagnostics captured by running TypeScript metadata-server
  output-preview helpers, with lease timestamps normalized after execution.

## Metadata Store

- `metadata-store/store.json`: persisted metadata load/save, topology-owned
  field scrubbing, loop/control-session flags, no-op writes, statusline segment
  replacement/expiry/drop/rejection, and malformed rail cases captured by
  running the TypeScript metadata store against temporary project state.

## Metadata Watchers

- `metadata-watchers/builtin.json`: builtin status, plan-progress, task, and
  history watcher metadata side-effect calls captured by running TypeScript
  `createBuiltinMetadataWatchers` against temporary project state.

## Orchestration

- `orchestration/actions.json`: task, handoff, review, thread-reopen, and
  runtime-exchange side-effect contracts captured by running TypeScript
  orchestration action helpers with generated IDs and timestamps normalized
  after structure checks.
- `orchestration/routing.json`: direct, role, tool, worktree, liveness, and
  workflow-pressure recipient routing captured by running TypeScript
  `orchestration-routing` helpers.

## Workflow

- `workflow/entries.json`: workflow entry, coordination-thread, filter, family,
  and next-action contracts captured by running TypeScript `workflow` helpers
  over runtime-exchange snapshots.

## Runtime

- `runtime/cli-launcher.json`: daemon, dashboard, project-service, native
  dashboard, symlink-alias, source-checkout, and diagnostic CLI launch-command
  selection captured by running TypeScript `cli-launcher` helpers with
  machine-specific paths normalized.

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

## Runtime Restart

- `runtime-restart/render.json`: user-facing runtime restart summary rendering
  captured by running TypeScript `renderRuntimeRestartResult`.

## Visual Client Leases

- `visual-client-leases/leases.json`: visual client lease kind parsing,
  identity sanitization, TTL clamping, renewal, pruning, preview counts, and
  snapshot ordering captured by running TypeScript `visual-client-leases`
  helpers.

## Worktrees

- `worktrees/colors.json`: worktree color key, hash, RGB, hex, ANSI, palette
  spread, and known project color contracts captured by running TypeScript
  `worktree-colors` helpers.

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

- `debug/logging.json`: debug logging config precedence, level/category gating,
  always-log records, and secret redaction behavior captured by running
  TypeScript `debug` helpers with timestamps and pids normalized.
- `debug/lifecycle-log.json`: control-plane lifecycle log writes, daemon-log
  destination, process id presence, and sensitive-field redaction captured by
  running TypeScript `logLifecycleAlways`; the Rust fixture is an ignored
  checklist until the logging subsystem is ported.

## Dashboard

- `dashboard/index.json`: dashboard derived status label precedence for
  semantic labels, pending-action overrides, and raw waiting fallback captured
  by running TypeScript `Dashboard` index helpers.
- `dashboard/orphans.json`: stale dashboard build detection, dashboard
  entrypoint recognition, orphan parent-chain detection, current-process
  exclusion, and live-pane ancestry captured by running TypeScript
  `dashboard-orphans` helpers.
- `dashboard/order.json`: dashboard saved-order keying, stale-id
  normalization, movement, and per-worktree session/service ordering captured
  by running TypeScript `dashboard/order` helpers.
- `dashboard/pending-actions.json`: dashboard pending-action blocking-kind
  policy captured by running TypeScript `isBlockingPendingDashboardActionKind`.
- `dashboard/quick-jump.json`: dashboard quick-jump worktree and entry
  numbering plus digit target resolution captured by running TypeScript
  `dashboard/quick-jump` helpers.
- `dashboard/session-registry.json`: dashboard session dedupe,
  hidden-worktree filtering, teammate inclusion, teammate metadata
  preservation, and teammate ordering captured by running TypeScript
  `dashboard/session-registry` helpers.
- `dashboard/session-actions.json`: dashboard stop, graveyard, and offline
  resume result states plus side-effect call ordering captured by running
  TypeScript `dashboard/session-actions` helpers with a deterministic clock for
  timeout paths.
- `dashboard/visibility.json`: dashboard offline-session classification and
  hide-offline model filtering captured by running TypeScript
  `dashboard/visibility` helpers.

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

## Service Client

- `service-client/client.json`: daemon JSON request behavior, core command
  daemon-start gating/transport options, and CLI control-plane restart
  orchestration/callback side effects captured by running TypeScript client
  helpers with mocked dependencies.

## Service

- `service/local-ui-server.json`: local UI server app shell, runtime config,
  routed fallback, immutable assets, traversal rejection, and loopback binding
  behavior captured by running TypeScript `startLocalUiServer` against a
  temporary UI root.

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

- `cli/agent-id.json`: agent identity JSON payload and human-readable identity
  line rendering captured by running TypeScript `cli/agent-id` helpers.
- `cli/team.json`: team CLI role-list rendering, init rendering, and JSON
  payload helper behavior captured by running TypeScript `cli/team` helpers;
  commander route registration remains on the fenced core CLI/daemon text path.
- `cli/parsing.json`: process command-line flag value matching and shell/env
  assignment parsing captured by running TypeScript `process-args` and
  `shell-args`.
- `cli/metadata-command.json`: metadata CLI endpoint printing, service URL
  mapping, set-services posting, and non-numeric progress rejection captured by
  running TypeScript `registerMetadataCommand` with recorded dependencies.
- `cli/logs-command.json`: logs CLI path/tail/clear/empty-tail console output
  and dependency calls captured by running TypeScript `registerLogsCommand`
  with recorded dependencies.
- `cli/work-outline-command.json`: work outline CLI rendering, list/show query
  construction, and update posting captured by running TypeScript
  `registerWorkOutlineCommand` with recorded dependencies.

## Shell

- `shell/hooks.json`: shell integration argv wrapping, zsh/bash integration
  file generation, zshenv preservation, protected control environment ordering,
  shell quoting, and suppression marker behavior captured by running TypeScript
  `shell-hooks`.

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

- `default-plugins/gh-pr-context.json`: default GitHub PR context target
  selection from topology sessions, statusline fallback paths, metadata
  fallback paths, service rows, duplicate filtering, and missing-path filtering
  captured by running TypeScript `collectGithubPrTargets`.
- `default-plugins/transcript-length.json`: default transcript-length plugin
  statusline writes, compaction-checkpoint reset behavior, empty-history
  rendering, external transcript-path byte counts, and stale-session clearing
  captured by running TypeScript `createTranscriptLengthPlugin`.
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
- `multiplexer/services.json`: service launch-command recovery, service-state
  metadata projection, and service-label derivation captured by running
  TypeScript `multiplexer/services` helpers; tmux-backed mutation flows are
  fenced out.
- `multiplexer/services-runtime.json`: service create/stop/remove/resume
  side-effect behavior, including tmux call order, failure-debug shell wrapping,
  saved offline services, optimistic dashboard seeds, and topology service
  projections captured by running TypeScript `multiplexer/services` against
  deterministic fake tmux hosts and temp state files.
- `multiplexer/worktrees.json`: dashboard worktree settle-poll backoff,
  worktree create input, removal confirmation, removal completion, and list
  dismissal plus worktree cache cleanup preview/apply contracts captured by
  running TypeScript `multiplexer/worktrees` helpers against deterministic fake
  dashboard hosts.
- `multiplexer/persistence-worktrees.json`: persistence worktree create,
  remove, graveyard, resurrection, deletion, host side effects, operation
  failure records, pending dashboard actions, graveyard session resurrection,
  graveyard cleanup wrapper refreshes, and topology transitions captured by running TypeScript
  `multiplexer/persistence-methods` against temporary git repositories and
  isolated topology state.
- `multiplexer/runtime-state-methods.json`: runtime-state dashboard removal
  index adjustment, stop-to-offline topology persistence, graveyard session
  mutation, live tmux metadata checks, topology reconciliation, offline
  session/service loading, orphaned service demotion, and live service
  projection captured by running TypeScript `multiplexer/runtime-state`
  helpers against isolated project state.
- `multiplexer/runtime-lifecycle-methods.json`: runtime lifecycle legacy
  instruction-file managed-block cleanup and tracking reset side effects
  captured by running TypeScript `runtimeLifecycleMethods` against temporary
  project files.
- `runtime-state/guard-repair-history.json`: dashboard runtime-guard repair
  attempt persistence, project-key normalization, window pruning, clearing, and
  corrupt-history recovery captured by running TypeScript
  `runtime-guard-repair-history`.
- `runtime-state/last-used.json`: last-used recency ordering, monotonic
  timestamp updates, per-client isolation, pruning, and legacy seeding captured
  by running TypeScript `last-used`.
- `runtime-state/lifecycle-orphans.json`: lifecycle-validation process and
  tmux-session orphan classification, dashboard orphan reaping, pid-reread
  guards, and killed-process/session side effects captured by running
  TypeScript `lifecycle-orphans` helpers.
- `runtime-state/runtime-guard.json`: runtime guard state classification,
  equality, disconnected-probe stabilization, guarded key disposition, and
  overlay copy captured by running TypeScript `multiplexer/runtime-guard`.
- `runtime-state/runtime-sync.json`: runtime sync heartbeat and project-service
  refresh timer behavior captured by running TypeScript
  `MultiplexerRuntimeSync` with recorded dependencies.
- `runtime-state/dashboard-api-client.json`: dashboard API client resource
  refresh, model refresh, mutation blocking, connection-state, and stale
  lifecycle behavior captured by running TypeScript
  `multiplexer/dashboard-api-client`.
- `runtime-state/dashboard-lifecycle.json`: dashboard lifecycle token capture,
  currentness checks, render gating, stale async suppression, and swallowed
  handler exception behavior captured by running TypeScript
  `multiplexer/dashboard-lifecycle`.
- `runtime-state/dashboard-model-service.json`: dashboard desktop-state model
  refresh, cache application, lifecycle staleness, invalid payload, and tmux
  contradiction behavior captured by running TypeScript
  `multiplexer/dashboard-model`.
- `runtime-state/dashboard-navigation.json`: dashboard migrate-picker worktree
  selection and overlay side effects captured by running TypeScript
  `multiplexer/navigation`.
- `runtime-state/dashboard-repair-notices.json`: dashboard repair notice
  recording, timestamp, flash suppression, and render side effects captured by
  running TypeScript `multiplexer/repair-notices`.
- `runtime-state/dashboard-ui-state-store.json`: dashboard UI shared/client
  persistence, screen normalization, selection restore, and item ordering
  behavior captured by running TypeScript `dashboard/ui-state-store`.
- `runtime-state/project-event-stream.json`: dashboard project event stream
  debounce/coalescing, hidden-dashboard rechecks, lifecycle suppression, SSE
  reconnect/backoff/idle timeout, alert flash, and buffered-event disposal
  behavior captured by running TypeScript `multiplexer/project-event-stream`.
- `runtime-state/tui-runtime-mutations.json`: TUI runtime mutation queue
  context coalescing, mark-seen retry, backoff preemption, and teardown side
  effects captured by running TypeScript `multiplexer/tui-runtime-mutations`.
- `multiplexer/tui-api-runtime.json`: TUI API mutation-blocking,
  recoverable-error, and read-transport policy decisions captured by running
  TypeScript `multiplexer/tui-api-runtime` pure helpers.
- `multiplexer/tool-picker.json`: tool picker default environment formatting,
  configured launch override, picker mode reset, picker/options overlay
  rendering, and non-dashboard launch dispatch behavior captured by running
  TypeScript `tool-picker` helpers.
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
- `runtime-state/tool-output-watchers.json`: tool pane prompt, active error,
  interrupted, and update-prompt classification captured by running TypeScript
  `classifyToolPane`.
- `runtime-state/drift.json`: local-build drift error classification captured
  by running TypeScript `runtime-drift`.
- `runtime-state/repair-events.json`: durable repair event JSONL logging
  captured by running TypeScript `repair-events`.
- `runtime-migration/migration.json`: report, explicit import, rollback,
  corrupt legacy file, global agent-dir copy avoidance, and blocked existing
  exchange behavior captured by running TypeScript `runtime-migration` helpers
  against temporary repositories.

## Tmux

- `tmux/dashboard-tui-visibility.json`: dashboard TUI visibility tmux parsing,
  stale-pane process recovery, host cache, and wake-transition behavior
  captured by running TypeScript `multiplexer/tui-visibility`.
- `tmux/attach-terminal-guard.json`: interactive-terminal detection,
  no-terminal attach errors, and attach-session argv behavior captured by
  running TypeScript `tmux/runtime-manager` helpers.
- `tmux/expose-layout.json`: expose grid layout, client-size matching, and
  preview row selection captured by running TypeScript `tmux/expose` helpers.
- `tmux/expose-model.json`: expose scope, request, focus, overseer, and
  UI-state behavior captured by running TypeScript expose helpers.
- `tmux/expose-render.json`: expose tile header fitting and ANSI tile rendering
  captured by running TypeScript `tmux/expose` helpers.
- `tmux/doctor.json`: tmux compatibility report, readable report rendering,
  symlink canonicalization, and alias-session repair side effects captured by
  running TypeScript `tmux/doctor` helpers with mocked tmux.
- `tmux/statusline-script.json`: tmux statusline cache-file lookup and
  silent-failure behavior captured by running the shipped shell script.
- `tmux/sync-exec-inventory.json`: synchronous tmux caller allowlist,
  stale-entry checks, and async/sync pattern probes captured by running
  TypeScript source inventory logic.

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

## Source Boundary

- `source-boundary/inventory.json`: core sidecar, runtime-exchange,
  TUI API, overlay viewport, and one-shot Node inventory violation lists
  captured by running TypeScript source-boundary scan logic.

## Terminal

- `terminal/host.json`: raw-mode and terminal-state restore escape-sequence
  writes, including focus-reporting disable/enable behavior, captured by
  running TypeScript `TerminalHost`.
- `terminal/hotkeys.json`: leader-key action mapping for work outline versus
  previous-session actions and transient indicator writes captured by running
  TypeScript `HotkeyHandler`.
- `terminal/key-parser.json`: carriage-return/line-feed Enter normalization,
  Alt+Enter normalization, and focus-report/key splitting captured by running
  TypeScript `parseKeys`.
- `terminal/line-editor.json`: single-line editor cursor movement, editing,
  paste newline normalization, key-consumption, reverse-video cursor, and
  horizontal scroll rendering captured by running TypeScript `line-editor`.
- `terminal/rich-text.json`: SGR rich-text run splitting, RGB color projection,
  multiline attribute carryover, inverse color handling, and plain-text
  projection captured by running TypeScript `rich-text`.

## Transcript

- `transcript/turn-state.json`: Claude/Codex transcript turn-state parsing,
  file-tail reads, transcript probing, and Codex rollout path lookup captured
  by running TypeScript `transcript-turn-state`.

## Transport

- `transport/core-command.json`: core command transport envelope posting,
  timeout forwarding, daemon error propagation, and mismatched response
  validation captured by running TypeScript `sendCoreCommand` with a mocked
  daemon client.
- `remote-access/access.json`: hosted remote-access operator/guest route
  allowlists, session binding, header actor parsing, attachment route
  hardening, and operator stream gates captured by running TypeScript
  remote-access helpers.
- `transport/route-share.json`: canonical shared route matching, legacy
  shared-session route fallback, owner/local route exclusion, active-share
  leakage handling, and shared chat href shape captured by running TypeScript
  route-share helpers.
- `transport/security.json`: shared-chat actor attribution plus client device
  proof signing-message and public-key encoding behavior captured by running
  TypeScript transport/security helpers.

## TUI

- `tui/render-text.json`: two-pane composition and SGR stripping behavior
  captured by running TypeScript `tui/render/text` helpers.
- `tui/render-box.json`: overlay box viewport, title-band, variant, ANSI body,
  and uniform row-width behavior captured by running TypeScript
  `tui/render/box` helpers.
- `tui/render-theme.json`: TUI theme primitive, status, keycap, footer, tmux
  token, and card rendering behavior captured by running TypeScript
  `tui/render/theme` helpers.
- `tui/dashboard-footer-hints.json`: dashboard footer hint ordering and labels
  captured by running TypeScript `buildDashboardFooterHints`.
- `tui/screen-overlays.json`: dashboard overlay raw ANSI output and visible
  text captured by running TypeScript `tui/screens/overlay-renderers` helpers.
- `tui/subscreen-renderers.json`: dashboard subscreen raw ANSI output and
  visible text captured by running TypeScript `tui/screens/subscreen-renderers`
  helpers.

## Worktree

- `worktree/cache-cleanup.json`: generated-cache planning, active-runtime
  protection, dry-run/apply behavior, cleanup-name allowlist, and summarized
  report rendering captured by running TypeScript `worktree-cache-cleanup`
  helpers.
- `worktree/state.json`: worktree path resolution, git worktree-add argv
  selection, internal scratch-worktree classification, graveyard topology
  projection, and graveyard view-model ordering captured by running TypeScript
  worktree and multiplexer helpers.

## Multiplexer

- `multiplexer/dashboard-interaction.json`: dashboard keyboard navigation,
  blocking, quick-jump, and screen-switch behavior captured by running
  TypeScript `dashboardInteractionMethods.handleDashboardKey`.
- `multiplexer/dashboard-state-helpers.json`: graveyard refresh state,
  dashboard-tail cache selectors, dashboard-view pending settlement hooks,
  persistence projection/text helpers, and live service state projection
  captured by running TypeScript multiplexer helpers.
- `multiplexer/library-refresh.json`: library resource refresh return values,
  host-state transitions, payload validation, coalescing, and project-service
  call logs captured by running TypeScript `refreshLibrary`.
- `multiplexer/notifications.json`: dashboard coordination notification host
  projection, worklist filtering, target labels/states, and notification
  mutation input shape captured by running TypeScript multiplexer notification
  helpers.
- `multiplexer/persistence-statusline-snapshot.json`: statusline session,
  teammate, metadata, task-count, and dashboard-order projection behavior
  captured by running TypeScript `persistenceMethods.buildStatuslineSnapshot`.
- `multiplexer/persistence-worktree-lists.json`: raw git worktree inventory
  and pending-removal projection separation captured by running TypeScript
  `persistenceMethods.listDesktopWorktrees` against a disposable git worktree.
- `multiplexer/project-refresh.json`: project observability refresh return
  values, host-state transitions, payload validation, coalescing, and
  project-service call logs captured by running TypeScript
  `refreshProjectObservability`.
- `multiplexer/runtime-helpers.json`: dashboard-control navigation/root helper
  behavior, session detail text rendering, launch redaction/default-scribe ID
  helpers, session-runtime label/activity helpers, and subscreen scoring/state
  text captured by running TypeScript multiplexer helper functions.
- `multiplexer/topology-refresh.json`: topology refresh return values,
  host-state transitions, payload validation, coalescing, and project-service
  call logs captured by running TypeScript `refreshTopology`.

## Work Outline

- `work-outline/outline.json`: work outline upsert, filtering, bounds,
  session-id truncation, and corrupt-state quarantine behavior captured by
  running TypeScript `work-outline` helpers.
