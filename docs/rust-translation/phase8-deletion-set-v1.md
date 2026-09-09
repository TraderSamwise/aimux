# Phase 8 Deletion Set v1

Audit point: f935537f

Scope: every `src/**/*.ts` file in the source checkout. This is an independent source-file deletion derivation, not the installed-runtime package-manifest proof that `dist/` can be absent.

Rule used here: `DELETE` requires behavior-level `PROVEN-FAILS` corpus evidence, a named Rust replacement, no KEEP classification, and no KEEP source file importing it. `KEEP` covers app imports, capture harness graph, source-checkout/dev entry graph, Vitest modules/support, and Vitest dependency graph. Everything else is `UNSURE`.

## Summary

| Bucket | Files | LOC |
| --- | ---: | ---: |
| DELETE | 0 | 0 |
| KEEP | 533 | 194814 |
| UNSURE | 2 | 165 |

Conclusion: this independent pass finds no `src/**/*.ts` file that satisfies the deletion rule. The current source tree is still intentionally retained by capture, Vitest, app, and source-checkout/dev graphs. The installed hot path can still be Node-free by excluding `dist/` and launching native binaries; that is a different artifact-level claim.

## Roots

- App roots: `src/agent-events-contract.ts`, `src/agent-transcript-contract.ts`, `src/attachment-text.ts`, `src/core-command-contract.ts`, `src/expose-preview-crop.ts`, `src/project-api-contract.ts`, `src/worktree-colors.ts`.
- Capture root count: 344.
- Vitest root/support count: 248.
- Source-checkout/dev roots: `src/main.ts`, `src/full/main.ts`, `src/launcher-bin.ts`, `src/local-launcher-bin.ts`, `src/cli-launcher.ts`, `src/dashboard/command-spec.ts`.
- Unique proven corpus paths considered: 320. The enforcement audit has more
  binding rows because some corpora are intentionally consumed by more than one
  Rust suite.

## Import-Graph Check

No files are classified `DELETE`, so there are no DELETE importers and no KEEP -> DELETE contradictions in this derivation.

## DELETE

None. No source file passed the full rule of proof plus no keep-graph membership plus no KEEP importer.

## UNSURE

| File | LOC | Reason | Source Importers |
| --- | ---: | --- | --- |
| `src/agent-watcher.ts` | 19 | no behavior-level PROVEN-FAILS corpus mapped to this source file | - |
| `src/recorder.ts` | 146 | no behavior-level PROVEN-FAILS corpus mapped to this source file | - |

## KEEP

| File | LOC | Why Kept | Behavior Proof Seen |
| --- | ---: | --- | --- |
| `src/agent-events-contract.ts` | 38 | app import graph; capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/agent-events.ts` | 14 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/agent-output-activity-text.test.ts` | 62 | vitest test module; capture harness graph | testdata/contracts/v1/agent-output/activity-text.json<br>testdata/contracts/v1/agent-output/parser-activity-text.json<br>testdata/contracts/v1/agent-output/parser-adversarial.json |
| `src/agent-output-bounds.test.ts` | 50 | vitest test module | testdata/contracts/v1/agent-output/bounds.json |
| `src/agent-output-bounds.ts` | 36 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/agent-output/bounds.json |
| `src/agent-output-parser-audit.test.ts` | 512 | vitest test module; capture harness graph | testdata/contracts/v1/agent-output/parser-audit.json |
| `src/agent-output-parser-audit.ts` | 223 | capture harness graph; vitest dependency graph | - |
| `src/agent-output-parser-compact.test.ts` | 286 | vitest test module; capture harness graph | testdata/contracts/v1/agent-output/parser-adversarial.json |
| `src/agent-output-parser-contract.ts` | 44 | capture harness graph; vitest dependency graph | - |
| `src/agent-output-parser-fixtures.test.ts` | 120 | vitest test module; capture harness graph | testdata/contracts/v1/agent-output/parser-adversarial.json |
| `src/agent-output-parser-fixtures.ts` | 610 | capture harness graph; vitest dependency graph | testdata/contracts/v1/agent-output/parser-adversarial.json |
| `src/agent-output-parser-fuzz.test.ts` | 446 | vitest test module; capture harness graph | testdata/contracts/v1/agent-output/parser-fuzz.json |
| `src/agent-output-parser-harness.test.ts` | 163 | vitest test module; capture harness graph | testdata/contracts/v1/agent-output/parser-adversarial.json |
| `src/agent-output-parser-harness.ts` | 72 | capture harness graph; vitest dependency graph | - |
| `src/agent-output-parser-test-utils.ts` | 8 | vitest/capture support; capture harness graph; vitest dependency graph | - |
| `src/agent-output-parser.test.ts` | 976 | vitest test module; capture harness graph | testdata/contracts/v1/agent-output/parser-adversarial.json |
| `src/agent-output-parser.ts` | 839 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/agent-output-read-metrics.test.ts` | 99 | vitest test module | testdata/contracts/v1/agent-output/read-metrics.json |
| `src/agent-output-read-metrics.ts` | 168 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/agent-output/read-metrics.json |
| `src/agent-output-stream.test.ts` | 38 | vitest test module | testdata/contracts/v1/agent-output/stream.json |
| `src/agent-output-stream.ts` | 83 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/agent-output/stream.json |
| `src/agent-prompt-delivery.test.ts` | 310 | vitest test module; capture harness graph | testdata/contracts/v1/agent-prompt-delivery/delivery.json |
| `src/agent-prompt-delivery.ts` | 378 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/agent-tracker.test.ts` | 126 | vitest test module | testdata/contracts/v1/agent-output/tracker.json |
| `src/agent-tracker.ts` | 201 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/agent-transcript-contract.ts` | 54 | app import graph; capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/agent-transcript.test.ts` | 878 | vitest test module; capture harness graph | testdata/contracts/v1/agent-output/transcript.json |
| `src/agent-transcript.ts` | 578 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/alert-display.test.ts` | 93 | vitest test module | testdata/contracts/v1/alerts/display.json |
| `src/alert-display.ts` | 216 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/alerts/display.json |
| `src/atomic-write.test.ts` | 85 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/atomic-write.json |
| `src/atomic-write.ts` | 90 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/attachment-store.test.ts` | 357 | vitest test module; capture harness graph | testdata/contracts/v1/attachments/store.json |
| `src/attachment-store.ts` | 631 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/attachment-text.test.ts` | 115 | vitest test module | testdata/contracts/v1/attachments/text.json |
| `src/attachment-text.ts` | 183 | app import graph; capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/attachments/text.json |
| `src/backend-session-discovery.test.ts` | 225 | vitest test module | testdata/contracts/v1/backend-session-discovery/discovery.json |
| `src/backend-session-discovery.ts` | 217 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/backend-session-discovery/discovery.json |
| `src/build-profile.ts` | 30 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/builtin-metadata-watchers.test.ts` | 335 | vitest test module; capture harness graph | testdata/contracts/v1/metadata-watchers/builtin.json |
| `src/builtin-metadata-watchers.ts` | 186 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/claude-hooks.test.ts` | 142 | vitest test module; capture harness graph | testdata/contracts/v1/hooks/tool-hooks.json |
| `src/claude-hooks.ts` | 217 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/cli-launcher.test.ts` | 144 | vitest test module; capture harness graph | testdata/contracts/v1/runtime/cli-launcher.json |
| `src/cli-launcher.ts` | 192 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/runtime/cli-launcher.json |
| `src/cli/agent-id.test.ts` | 64 | vitest test module; capture harness graph | testdata/contracts/v1/cli/agent-id.json |
| `src/cli/agent-id.ts` | 52 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/cli/agent-list.test.ts` | 59 | vitest test module; capture harness graph | testdata/contracts/v1/cli/agent-list.json |
| `src/cli/agent-list.ts` | 76 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/cli/attachment.test.ts` | 94 | vitest test module; capture harness graph | testdata/contracts/v1/cli/attachment.json |
| `src/cli/attachment.ts` | 121 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/cli/logs.test.ts` | 75 | vitest test module; capture harness graph | testdata/contracts/v1/cli/logs-command.json |
| `src/cli/logs.ts` | 59 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/cli/metadata.test.ts` | 82 | vitest test module; capture harness graph | testdata/contracts/v1/cli/metadata-command.json |
| `src/cli/metadata.ts` | 198 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/cli/project-service.test.ts` | 40 | vitest test module; capture harness graph | testdata/contracts/v1/cli/project-service.json |
| `src/cli/project-service.ts` | 513 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/cli/team.test.ts` | 84 | vitest test module; capture harness graph | testdata/contracts/v1/cli/team.json |
| `src/cli/team.ts` | 140 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/cli/work-outline.test.ts` | 133 | vitest test module; capture harness graph | testdata/contracts/v1/cli/work-outline-command.json |
| `src/cli/work-outline.ts` | 152 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/codex-hooks.test.ts` | 146 | vitest test module; capture harness graph | testdata/contracts/v1/hooks/tool-hooks.json |
| `src/codex-hooks.ts` | 109 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/config.test.ts` | 522 | vitest test module; capture harness graph | testdata/contracts/v1/config/behavior.json |
| `src/config.ts` | 583 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/connection-targets.test.ts` | 101 | vitest test module; capture harness graph | testdata/contracts/v1/connection-targets/targets.json |
| `src/connection-targets.ts` | 35 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/context/compactor.test.ts` | 94 | vitest test module; capture harness graph | testdata/contracts/v1/context/compactor.json |
| `src/context/compactor.ts` | 252 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/context/context-bridge.test.ts` | 212 | vitest test module; capture harness graph | testdata/contracts/v1/context/bridge.json |
| `src/context/context-bridge.ts` | 578 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/context/context-file.ts` | 116 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/context/history.ts` | 135 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/control-plane-restart-client.test.ts` | 142 | vitest test module; capture harness graph | testdata/contracts/v1/service-client/client.json |
| `src/control-plane-restart-client.ts` | 34 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/coordination-model.test.ts` | 290 | vitest test module | testdata/contracts/v1/coordination/model.json |
| `src/coordination-model.ts` | 365 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/coordination/model.json |
| `src/core-cli-open.ts` | 8 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/core-cli-remote-features.ts` | 44 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/core-cli-routing.ts` | 237 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/core-command/ownership.json |
| `src/core-cli.test.ts` | 654 | vitest test module; capture harness graph | testdata/contracts/v1/integration/src-surfaces.json |
| `src/core-cli.ts` | 416 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/core-command-client.test.ts` | 61 | vitest test module; capture harness graph | testdata/contracts/v1/service-client/client.json |
| `src/core-command-client.ts` | 15 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/core-command-contract.test.ts` | 86 | vitest test module; capture harness graph | testdata/contracts/v1/core-command/behavior.json<br>testdata/contracts/v1/core-command/commands.json<br>testdata/contracts/v1/core-command/routes.json |
| `src/core-command-contract.ts` | 299 | app import graph; capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/core-command/commands.json<br>testdata/contracts/v1/core-command/routes.json |
| `src/core-command-ownership.test.ts` | 408 | vitest test module; capture harness graph | testdata/contracts/v1/core-command/ownership.json |
| `src/core-command-transport.test.ts` | 63 | vitest test module; capture harness graph | testdata/contracts/v1/transport/core-command.json |
| `src/core-command-transport.ts` | 34 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/core-project-actor.test.ts` | 238 | vitest test module; capture harness graph | testdata/contracts/v1/integration/src-surfaces.json |
| `src/core-project-actor.ts` | 324 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/core-sidecar-boundary.test.ts` | 107 | vitest test module; capture harness graph | - |
| `src/core-text.ts` | 859 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/daemon-client.test.ts` | 68 | vitest test module; capture harness graph | testdata/contracts/v1/service-client/client.json |
| `src/daemon-client.ts` | 20 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/daemon-remote-features.ts` | 136 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/daemon-state.test.ts` | 85 | vitest test module; capture harness graph | testdata/contracts/v1/daemon-state/state.json |
| `src/daemon-state.ts` | 139 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/daemon-supervisor-build-generation.test.ts` | 75 | vitest test module; capture harness graph | testdata/contracts/v1/daemon-supervisor/build-generation.json |
| `src/daemon-supervisor.ts` | 478 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/daemon.test.ts` | 5388 | vitest test module; capture harness graph | testdata/contracts/v1/integration/src-surfaces.json |
| `src/daemon.ts` | 4569 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/daemon/projects-route.test.ts` | 69 | vitest test module; capture harness graph | testdata/contracts/v1/daemon/projects-route-counts.json |
| `src/daemon/projects-route.ts` | 125 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/daemon/projects-route-counts.json |
| `src/dashboard-orphans.test.ts` | 195 | vitest test module; capture harness graph | testdata/contracts/v1/dashboard/orphans.json |
| `src/dashboard-orphans.ts` | 101 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/dashboard/orphans.json |
| `src/dashboard/command-spec.test.ts` | 209 | vitest test module; capture harness graph | testdata/contracts/v1/dashboard/command-spec.json |
| `src/dashboard/command-spec.ts` | 228 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/dashboard/command-spec.json |
| `src/dashboard/feedback.ts` | 142 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/dashboard/index.test.ts` | 268 | vitest test module; capture harness graph | testdata/contracts/v1/dashboard/index.json |
| `src/dashboard/index.ts` | 259 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/dashboard/index.json |
| `src/dashboard/operation-failures.test.ts` | 94 | vitest test module; capture harness graph | testdata/contracts/v1/operation-failures/failures.json |
| `src/dashboard/operation-failures.ts` | 136 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/dashboard/order.test.ts` | 62 | vitest test module; capture harness graph | testdata/contracts/v1/dashboard/order.json |
| `src/dashboard/order.ts` | 93 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/dashboard/pending-actions.test.ts` | 599 | vitest test module; capture harness graph | testdata/contracts/v1/dashboard/pending-actions.json |
| `src/dashboard/pending-actions.ts` | 410 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/dashboard/quick-jump.test.ts` | 302 | vitest test module; capture harness graph | testdata/contracts/v1/dashboard/quick-jump.json |
| `src/dashboard/quick-jump.ts` | 190 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/dashboard/quick-jump.json |
| `src/dashboard/runtime-evidence.ts` | 24 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/dashboard/session-actions.test.ts` | 240 | vitest test module; capture harness graph | testdata/contracts/v1/dashboard/session-actions.json |
| `src/dashboard/session-actions.ts` | 128 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/dashboard/session-actions.json |
| `src/dashboard/session-registry.test.ts` | 232 | vitest test module; capture harness graph | testdata/contracts/v1/dashboard/session-registry.json |
| `src/dashboard/session-registry.ts` | 242 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/dashboard/session-registry.json |
| `src/dashboard/sort.ts` | 18 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/dashboard/quick-jump.json |
| `src/dashboard/state.ts` | 97 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/dashboard/targets.test.ts` | 202 | vitest test module; capture harness graph | testdata/contracts/v1/dashboard/targets.json |
| `src/dashboard/targets.ts` | 143 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/dashboard/targets.json<br>testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/dashboard/ui-state-store.test.ts` | 310 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/dashboard-ui-state-store.json |
| `src/dashboard/ui-state-store.ts` | 300 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/dashboard/visibility.test.ts` | 103 | vitest test module; capture harness graph | testdata/contracts/v1/dashboard/desktop-state-counts.json<br>testdata/contracts/v1/dashboard/visibility.json |
| `src/dashboard/visibility.ts` | 63 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/dashboard/desktop-state-counts.json |
| `src/debug-lifecycle-log.test.ts` | 60 | vitest test module; capture harness graph | testdata/contracts/v1/debug/lifecycle-log.json |
| `src/debug-state.test.ts` | 355 | vitest test module; capture harness graph | testdata/contracts/v1/debug-state/report.json |
| `src/debug-state.ts` | 707 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/debug.test.ts` | 185 | vitest test module; capture harness graph | testdata/contracts/v1/debug/logging.json |
| `src/debug.ts` | 366 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/default-plugins/gh-pr-context.test.ts` | 60 | vitest test module; capture harness graph | testdata/contracts/v1/default-plugins/gh-pr-context.json |
| `src/default-plugins/gh-pr-context.ts` | 326 | capture harness graph; vitest dependency graph | - |
| `src/default-plugins/transcript-length.test.ts` | 162 | vitest test module; capture harness graph | testdata/contracts/v1/default-plugins/transcript-length.json |
| `src/default-plugins/transcript-length.ts` | 116 | capture harness graph; vitest dependency graph | - |
| `src/desktop-notifier.test.ts` | 295 | vitest test module; capture harness graph | testdata/contracts/v1/desktop-notifier/notifier.json |
| `src/desktop-notifier.ts` | 244 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/disk-doctor.ts` | 126 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/error-display.test.ts` | 22 | vitest test module; capture harness graph | testdata/contracts/v1/error-display/display.json |
| `src/error-display.ts` | 25 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/event-loop-budget.test.ts` | 138 | vitest test module; capture harness graph | testdata/contracts/v1/event-loop/budget.json |
| `src/event-loop-budget.ts` | 85 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/event-loop-metrics.test.ts` | 61 | vitest test module; capture harness graph | testdata/contracts/v1/event-loop/metrics.json |
| `src/event-loop-metrics.ts` | 65 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/expose-control.test.ts` | 49 | vitest test module; capture harness graph | testdata/contracts/v1/expose/control.json |
| `src/expose-control.ts` | 57 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/expose-hot-snapshot-worker.ts` | 215 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/expose-hot-snapshot-worker.json<br>testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/expose-pane-output-tap.test.ts` | 437 | vitest test module | testdata/contracts/v1/expose/pane-output-tap.json |
| `src/expose-pane-output-tap.ts` | 461 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/expose/pane-output-tap.json<br>testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/expose-preview-cache.test.ts` | 298 | vitest test module; capture harness graph | testdata/contracts/v1/expose/preview-cache.json |
| `src/expose-preview-cache.ts` | 248 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/expose-preview-crop.test.ts` | 23 | vitest test module; capture harness graph | testdata/contracts/v1/expose/preview-crop.json |
| `src/expose-preview-crop.ts` | 17 | app import graph; capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/external-notifications.ts` | 4 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/fast-control.test.ts` | 855 | vitest test module; capture harness graph | testdata/contracts/v1/fast-control/switching.json |
| `src/fast-control.ts` | 407 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/full/attachment-hosting.ts` | 48 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/full/core-cli-remote-features.ts` | 49 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/full/credentials.ts` | 56 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/full/daemon-remote-features.ts` | 160 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/full/hosted-audit.test.ts` | 259 | vitest test module; capture harness graph | testdata/contracts/v1/hosted/audit.json |
| `src/full/hosted-audit.ts` | 261 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/full/hosted-auth.test.ts` | 89 | vitest test module; capture harness graph | testdata/contracts/v1/hosted/auth.json |
| `src/full/hosted-auth.ts` | 63 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/full/hosted-config.test.ts` | 264 | vitest test module; capture harness graph | testdata/contracts/v1/hosted/config.json |
| `src/full/hosted-config.ts` | 276 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/full/hosted-events.test.ts` | 259 | vitest test module; capture harness graph | testdata/contracts/v1/hosted/events.json |
| `src/full/hosted-events.ts` | 346 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/full/hosted-lock.ts` | 75 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/full/hosted-lockdown.test.ts` | 138 | vitest test module; capture harness graph | testdata/contracts/v1/hosted/lockdown.json |
| `src/full/hosted-lockdown.ts` | 91 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/full/hosted-outbox.ts` | 125 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/full/hosted-principals.test.ts` | 248 | vitest test module; capture harness graph | testdata/contracts/v1/hosted/principals.json |
| `src/full/hosted-principals.ts` | 305 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/full/hosted-rate-limit.test.ts` | 86 | vitest test module; capture harness graph | testdata/contracts/v1/hosted/rate-limit.json |
| `src/full/hosted-rate-limit.ts` | 119 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/hosted/rate-limit.json |
| `src/full/hosted-server.test.ts` | 1112 | vitest test module; capture harness graph | testdata/contracts/v1/integration/src-surfaces.json |
| `src/full/hosted-server.ts` | 992 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/full/login-flow.ts` | 149 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/full/main.ts` | 3742 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/full/mobile-push-bridge.test.ts` | 53 | vitest test module; capture harness graph | testdata/contracts/v1/notifications/mobile-push.json |
| `src/full/relay-client.test.ts` | 262 | vitest test module; capture harness graph | testdata/contracts/v1/relay/client.json |
| `src/full/relay-client.ts` | 400 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/full/remote-access.test.ts` | 468 | vitest test module; capture harness graph | testdata/contracts/v1/remote-access/access.json |
| `src/full/remote-access.ts` | 289 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/full/security-devices-client.ts` | 102 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/graveyard-cleanup.test.ts` | 346 | vitest test module; capture harness graph | testdata/contracts/v1/graveyard/cleanup.json |
| `src/graveyard-cleanup.ts` | 277 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/hotkeys.test.ts` | 36 | vitest test module; capture harness graph | testdata/contracts/v1/terminal/hotkeys.json |
| `src/hotkeys.ts` | 166 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/http-client.ts` | 190 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/inbox-cleanup.test.ts` | 122 | vitest test module; capture harness graph | testdata/contracts/v1/notifications/inbox-cleanup.json |
| `src/inbox-cleanup.ts` | 170 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/install-cleanup.test.ts` | 326 | vitest test module; capture harness graph | testdata/contracts/v1/install-cleanup/cleanup.json |
| `src/install-cleanup.ts` | 373 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/install-config.test.ts` | 137 | vitest test module; capture harness graph | testdata/contracts/v1/install-config/config.json |
| `src/install-config.ts` | 117 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/install-doctor.test.ts` | 89 | vitest test module; capture harness graph | testdata/contracts/v1/install-cleanup/doctor.json |
| `src/install-doctor.ts` | 87 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/installed-shim.test.ts` | 74 | vitest test module; capture harness graph | testdata/contracts/v1/release/installed-shim.json |
| `src/interaction-requests.test.ts` | 123 | vitest test module; capture harness graph | testdata/contracts/v1/interaction-requests/registry.json |
| `src/interaction-requests.ts` | 234 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/key-parser.test.ts` | 23 | vitest test module; capture harness graph | testdata/contracts/v1/terminal/key-parser.json |
| `src/key-parser.ts` | 331 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/last-used.test.ts` | 150 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/last-used.json |
| `src/last-used.ts` | 199 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/launcher-bin.ts` | 6 | source-checkout/dev entry graph | - |
| `src/launcher-defaults.ts` | 21 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/launcher-env.test.ts` | 123 | vitest test module; capture harness graph | testdata/contracts/v1/launch/launcher-env.json |
| `src/launcher-env.ts` | 46 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/library.test.ts` | 134 | vitest test module; capture harness graph | testdata/contracts/v1/library/entries.json |
| `src/library.ts` | 95 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/lifecycle-orphans.test.ts` | 306 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/lifecycle-orphans.json |
| `src/lifecycle-orphans.ts` | 221 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/line-editor.test.ts` | 127 | vitest test module; capture harness graph | testdata/contracts/v1/terminal/line-editor.json |
| `src/line-editor.ts` | 117 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/local-launcher-bin.ts` | 6 | source-checkout/dev entry graph | - |
| `src/local-launcher-env.ts` | 44 | source-checkout/dev entry graph | - |
| `src/local-ui-server.test.ts` | 112 | vitest test module; capture harness graph | testdata/contracts/v1/service/local-ui-server.json |
| `src/local-ui-server.ts` | 221 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/logs.ts` | 33 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/loop-watcher.test.ts` | 272 | vitest test module; capture harness graph | testdata/contracts/v1/coordination/loop-watcher.json |
| `src/loop-watcher.ts` | 203 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/main.ts` | 3147 | capture harness graph; source-checkout/dev entry graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/managed-launch-env.test.ts` | 130 | vitest test module; capture harness graph | testdata/contracts/v1/launch/managed-env.json |
| `src/managed-launch-env.ts` | 123 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/metadata-cli-routing.test.ts` | 74 | vitest test module; capture harness graph | testdata/contracts/v1/metadata-cli/routing.json |
| `src/metadata-cli-routing.ts` | 244 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/metadata-server.interaction.test.ts` | 360 | vitest test module; capture harness graph | testdata/contracts/v1/integration/src-surfaces.json |
| `src/metadata-server.test.ts` | 9210 | vitest test module; capture harness graph | testdata/contracts/v1/integration/src-surfaces.json |
| `src/metadata-server.ts` | 6628 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/metadata-server/agent-input.test.ts` | 78 | vitest test module; capture harness graph | testdata/contracts/v1/metadata-server/agent-input.json |
| `src/metadata-server/agent-input.ts` | 61 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/metadata-server/dashboard-client-state.test.ts` | 19 | vitest test module; capture harness graph | testdata/contracts/v1/metadata-server/dashboard-client-state.json |
| `src/metadata-server/dashboard-client-state.ts` | 66 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/metadata-server/expose-socket.test.ts` | 28 | vitest test module; capture harness graph | testdata/contracts/v1/metadata-server/expose-socket.json |
| `src/metadata-server/expose-socket.ts` | 70 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/metadata-server/http.test.ts` | 88 | vitest test module; capture harness graph | testdata/contracts/v1/metadata-server/http.json |
| `src/metadata-server/http.ts` | 163 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/metadata-server/interaction-display.test.ts` | 46 | vitest test module; capture harness graph | testdata/contracts/v1/metadata-server/interaction-display.json |
| `src/metadata-server/interaction-display.ts` | 88 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/metadata-server/library-documents.test.ts` | 31 | vitest test module; capture harness graph | testdata/contracts/v1/metadata-server/library-documents.json |
| `src/metadata-server/library-documents.ts` | 42 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/metadata-server/lifecycle-mutation-queue.test.ts` | 145 | vitest test module; capture harness graph | testdata/contracts/v1/metadata-server/lifecycle-mutation-queue.json |
| `src/metadata-server/lifecycle-mutation-queue.ts` | 287 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/metadata-server/options.ts` | 257 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/metadata-server/output-previews.test.ts` | 142 | vitest test module; capture harness graph | testdata/contracts/v1/metadata-server/output-previews.json |
| `src/metadata-server/output-previews.ts` | 530 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/metadata-store.test.ts` | 358 | vitest test module | testdata/contracts/v1/metadata-store/store.json |
| `src/metadata-store.ts` | 535 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/metadata-store/store.json |
| `src/mobile-push-bridge.ts` | 34 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/multiplexer/agent-io-methods.test.ts` | 35 | vitest test module; capture harness graph | testdata/contracts/v1/agent-output/io-methods.json |
| `src/multiplexer/agent-io-methods.ts` | 227 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/multiplexer/agent-output-liveness.test.ts` | 92 | vitest test module; capture harness graph | testdata/contracts/v1/agent-output/liveness.json |
| `src/multiplexer/archives.test.ts` | 428 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/dashboard-state-helpers.json |
| `src/multiplexer/archives.ts` | 343 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/multiplexer/coordination.ts` | 280 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/multiplexer/dashboard-actions-methods.ts` | 264 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/multiplexer/dashboard-api-client.test.ts` | 179 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/dashboard-api-client.json |
| `src/multiplexer/dashboard-api-client.ts` | 161 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/multiplexer/dashboard-control.test.ts` | 2799 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/runtime-guard-repair-start.json<br>testdata/contracts/v1/multiplexer/runtime-helpers.json |
| `src/multiplexer/dashboard-control.ts` | 1997 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/multiplexer/dashboard-control-activation.json<br>testdata/contracts/v1/multiplexer/dashboard-control-helpers.json<br>testdata/contracts/v1/multiplexer/dashboard-control-orchestration.json<br>testdata/contracts/v1/multiplexer/dashboard-control-overlay-output.json<br>testdata/contracts/v1/multiplexer/dashboard-control-overlays.json<br>testdata/contracts/v1/multiplexer/dashboard-control-project-service-request.json<br>testdata/contracts/v1/multiplexer/dashboard-control-runtime-guard-keys.json<br>testdata/contracts/v1/multiplexer/dashboard-control-worktree-sessions.json<br>testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/multiplexer/dashboard-interaction.test.ts` | 2797 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/dashboard-interaction.json |
| `src/multiplexer/dashboard-interaction.ts` | 1769 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/multiplexer/dashboard-interaction-activation.json<br>testdata/contracts/v1/multiplexer/dashboard-interaction-command-keys.json<br>testdata/contracts/v1/multiplexer/dashboard-interaction-navigation.json<br>testdata/contracts/v1/multiplexer/dashboard-interaction-orchestration-submit.json<br>testdata/contracts/v1/multiplexer/dashboard-interaction-overlays.json<br>testdata/contracts/v1/multiplexer/dashboard-interaction-review-request.json<br>testdata/contracts/v1/multiplexer/dashboard-interaction.json |
| `src/multiplexer/dashboard-lifecycle.test.ts` | 140 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/dashboard-lifecycle.json |
| `src/multiplexer/dashboard-lifecycle.ts` | 90 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/multiplexer/dashboard-model-service.test.ts` | 334 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/dashboard-model-service.json |
| `src/multiplexer/dashboard-model.test.ts` | 2571 | vitest test module; capture harness graph | testdata/contracts/v1/dashboard/desktop-state-counts.json |
| `src/multiplexer/dashboard-model.ts` | 1832 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/dashboard/desktop-state-golden.json<br>testdata/contracts/v1/multiplexer/dashboard-model-apply.json<br>testdata/contracts/v1/multiplexer/dashboard-model-metadata-pending.json<br>testdata/contracts/v1/multiplexer/dashboard-model-pending-actions.json<br>testdata/contracts/v1/multiplexer/dashboard-model-services-lifecycle.json<br>testdata/contracts/v1/multiplexer/dashboard-worktree-groups.json<br>testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/multiplexer/dashboard-ops.test.ts` | 2985 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/runtime-helpers.json |
| `src/multiplexer/dashboard-ops.ts` | 1733 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/multiplexer/dashboard-ops-agent-actions.json<br>testdata/contracts/v1/multiplexer/dashboard-ops-helpers.json<br>testdata/contracts/v1/multiplexer/dashboard-ops-mutations.json<br>testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/multiplexer/dashboard-state-methods.ts` | 340 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/multiplexer/dashboard-tail-methods.test.ts` | 1687 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/dashboard-state-helpers.json |
| `src/multiplexer/dashboard-tail-methods.ts` | 1525 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/multiplexer/dashboard-tail-actions.json<br>testdata/contracts/v1/multiplexer/dashboard-tail-lifecycle.json<br>testdata/contracts/v1/multiplexer/dashboard-tail-session-create.json<br>testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/multiplexer/dashboard-view-methods.test.ts` | 579 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/dashboard-state-helpers.json |
| `src/multiplexer/dashboard-view-methods.ts` | 358 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/dashboard/desktop-state-counts.json |
| `src/multiplexer/desktop-state-golden.test.ts` | 303 | vitest test module; capture harness graph | testdata/contracts/v1/dashboard/desktop-state-golden.json |
| `src/multiplexer/graveyard-view-model.test.ts` | 297 | vitest test module; capture harness graph | testdata/contracts/v1/worktree/state.json |
| `src/multiplexer/graveyard-view-model.ts` | 368 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tui/subscreen-renderers.json |
| `src/multiplexer/inbox-cleanup-runtime.test.ts` | 68 | vitest test module; capture harness graph | testdata/contracts/v1/notifications/inbox-cleanup-runtime.json |
| `src/multiplexer/index.ts` | 808 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/multiplexer/index-helpers.json<br>testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/multiplexer/library.test.ts` | 201 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/library-refresh.json |
| `src/multiplexer/library.ts` | 161 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/multiplexer/library-refresh.json |
| `src/multiplexer/navigation.test.ts` | 45 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/dashboard-navigation.json |
| `src/multiplexer/navigation.ts` | 268 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/multiplexer/notifications.test.ts` | 733 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/notifications.json |
| `src/multiplexer/notifications.ts` | 290 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/multiplexer/persistence-methods.test.ts` | 1633 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/dashboard-state-helpers.json<br>testdata/contracts/v1/multiplexer/persistence-desktop-projection.json<br>testdata/contracts/v1/multiplexer/persistence-reapply.json<br>testdata/contracts/v1/multiplexer/persistence-statusline-snapshot.json<br>testdata/contracts/v1/multiplexer/persistence-statusline.json<br>testdata/contracts/v1/multiplexer/persistence-worktree-lists.json<br>testdata/contracts/v1/multiplexer/persistence-worktrees.json |
| `src/multiplexer/persistence-methods.ts` | 1523 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/multiplexer/project-event-stream.test.ts` | 656 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/project-event-stream.json |
| `src/multiplexer/project-event-stream.ts` | 483 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/multiplexer/project.test.ts` | 219 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/project-refresh.json |
| `src/multiplexer/project.ts` | 180 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/multiplexer/project-refresh.json |
| `src/multiplexer/repair-notices.test.ts` | 29 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/dashboard-repair-notices.json |
| `src/multiplexer/repair-notices.ts` | 46 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/multiplexer/runtime-guard.test.ts` | 693 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/runtime-guard.json |
| `src/multiplexer/runtime-guard.ts` | 251 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/runtime-state/runtime-guard.json<br>testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/multiplexer/runtime-lifecycle-methods.test.ts` | 850 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/runtime-lifecycle-methods.json |
| `src/multiplexer/runtime-lifecycle-methods.ts` | 379 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/multiplexer/runtime-state.test.ts` | 2502 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/dashboard-state-helpers.json<br>testdata/contracts/v1/multiplexer/runtime-state-methods.json<br>testdata/contracts/v1/multiplexer/runtime-state-refresh.json |
| `src/multiplexer/runtime-state.ts` | 989 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/multiplexer/runtime-sync.test.ts` | 45 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/runtime-sync.json |
| `src/multiplexer/runtime-sync.ts` | 51 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/runtime-state/runtime-sync.json |
| `src/multiplexer/service-state-snapshot.test.ts` | 238 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/service-state-snapshot.json |
| `src/multiplexer/service-state-snapshot.ts` | 98 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/multiplexer/services.test.ts` | 474 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/services-runtime.json<br>testdata/contracts/v1/multiplexer/services.json |
| `src/multiplexer/services.ts` | 452 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/multiplexer/session-capture.ts` | 21 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/multiplexer/session-launch.test.ts` | 3107 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/runtime-helpers.json |
| `src/multiplexer/session-launch.ts` | 1860 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/multiplexer/session-launch-actions.json<br>testdata/contracts/v1/multiplexer/session-launch-create.json<br>testdata/contracts/v1/multiplexer/session-launch-dashboard.json<br>testdata/contracts/v1/multiplexer/session-launch-default-scribe.json<br>testdata/contracts/v1/multiplexer/session-launch-migrate-switch.json<br>testdata/contracts/v1/multiplexer/session-launch-resume.json<br>testdata/contracts/v1/multiplexer/session-launch-startup.json<br>testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/multiplexer/session-runtime-core.test.ts` | 1337 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/runtime-helpers.json |
| `src/multiplexer/session-runtime-core.ts` | 988 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/multiplexer/session-runtime-agent-controls.json<br>testdata/contracts/v1/multiplexer/session-runtime-headline.json<br>testdata/contracts/v1/multiplexer/session-runtime-label-update.json<br>testdata/contracts/v1/multiplexer/session-runtime-metadata.json<br>testdata/contracts/v1/multiplexer/session-runtime-output.json<br>testdata/contracts/v1/multiplexer/session-runtime-tmux-metadata-sync.json<br>testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/multiplexer/subscreens.test.ts` | 327 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/runtime-helpers.json |
| `src/multiplexer/subscreens.ts` | 332 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/multiplexer/tool-picker.test.ts` | 193 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/tool-picker.json |
| `src/multiplexer/tool-picker.ts` | 481 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/multiplexer/topology.test.ts` | 197 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/topology-refresh.json |
| `src/multiplexer/topology.ts` | 197 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/multiplexer/topology-refresh.json |
| `src/multiplexer/transcript-reconciler.test.ts` | 205 | vitest test module; capture harness graph | testdata/contracts/v1/agent-output/transcript-reconciler.json |
| `src/multiplexer/transcript-reconciler.ts` | 169 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/multiplexer/tui-api-boundary.test.ts` | 70 | vitest test module; capture harness graph | - |
| `src/multiplexer/tui-api-runtime.test.ts` | 1098 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/tui-api-runtime.json |
| `src/multiplexer/tui-api-runtime.ts` | 640 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/multiplexer/tui-api-runtime-state.json<br>testdata/contracts/v1/multiplexer/tui-api-runtime.json |
| `src/multiplexer/tui-runtime-mutations.test.ts` | 213 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/tui-runtime-mutations.json |
| `src/multiplexer/tui-runtime-mutations.ts` | 132 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/multiplexer/tui-visibility.test.ts` | 263 | vitest test module; capture harness graph | testdata/contracts/v1/tmux/dashboard-tui-visibility.json |
| `src/multiplexer/tui-visibility.ts` | 267 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/multiplexer/worktree-graveyard.test.ts` | 47 | vitest test module; capture harness graph | testdata/contracts/v1/worktree/state.json |
| `src/multiplexer/worktree-graveyard.ts` | 36 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/multiplexer/worktrees.test.ts` | 1514 | vitest test module; capture harness graph | testdata/contracts/v1/multiplexer/worktrees-settlement.json<br>testdata/contracts/v1/multiplexer/worktrees.json |
| `src/multiplexer/worktrees.ts` | 957 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/notification-context.ts` | 109 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/notifications.test.ts` | 351 | vitest test module; capture harness graph | testdata/contracts/v1/notifications/store.json |
| `src/notifications.ts` | 433 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/notify.test.ts` | 109 | vitest test module; capture harness graph | testdata/contracts/v1/notifications/notify-alert.json |
| `src/notify.ts` | 100 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/one-shot-node-inventory.test.ts` | 263 | vitest test module; capture harness graph | - |
| `src/orchestration-actions.test.ts` | 227 | vitest test module; capture harness graph | testdata/contracts/v1/orchestration/actions.json |
| `src/orchestration-actions.ts` | 423 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/orchestration-routing.test.ts` | 110 | vitest test module; capture harness graph | testdata/contracts/v1/orchestration/routing.json |
| `src/orchestration-routing.ts` | 86 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/orchestration.test.ts` | 58 | vitest test module; capture harness graph | testdata/contracts/v1/coordination/mutations.json |
| `src/orchestration.ts` | 179 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/osc-notifications.test.ts` | 49 | vitest test module; capture harness graph | testdata/contracts/v1/notifications/osc.json |
| `src/osc-notifications.ts` | 195 | capture harness graph; vitest dependency graph | testdata/contracts/v1/notifications/osc.json |
| `src/package-manifest.test.ts` | 28 | vitest test module; capture harness graph | testdata/contracts/v1/release/package-manifest.json |
| `src/paths.test.ts` | 178 | vitest test module; capture harness graph | testdata/contracts/v1/paths/behavior.json |
| `src/paths.ts` | 537 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/pending-actions.ts` | 37 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/dashboard/pending-actions.json |
| `src/plugin-runtime.test.ts` | 222 | vitest test module; capture harness graph | testdata/contracts/v1/plugin/runtime.json |
| `src/plugin-runtime.ts` | 481 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/popup-expose.test.ts` | 39 | vitest test module; capture harness graph | testdata/contracts/v1/expose/popup-options.json |
| `src/popup-expose.ts` | 69 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/process-args.test.ts` | 22 | vitest test module; capture harness graph | testdata/contracts/v1/cli/parsing.json |
| `src/process-args.ts` | 19 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/process-inspector.test.ts` | 109 | vitest test module; capture harness graph | testdata/contracts/v1/process/inspector.json |
| `src/process-inspector.ts` | 117 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/project-api-contract.test.ts` | 116 | vitest test module; capture harness graph | testdata/contracts/v1/project-api/behavior.json<br>testdata/contracts/v1/project-api/routes.json |
| `src/project-api-contract.ts` | 1522 | app import graph; capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/project-api/routes.json |
| `src/project-events.ts` | 164 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/project-hook-command.ts` | 34 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/project-observability.test.ts` | 134 | vitest test module; capture harness graph | testdata/contracts/v1/project-observability/observability.json |
| `src/project-observability.ts` | 113 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/project-scanner.test.ts` | 395 | vitest test module; capture harness graph | testdata/contracts/v1/project-catalog/registry.json<br>testdata/contracts/v1/project-catalog/scanner.json |
| `src/project-scanner.ts` | 256 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/project-catalog/registry.json |
| `src/project-service-manifest.ts` | 95 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/project-takeover.test.ts` | 211 | vitest test module; capture harness graph | testdata/contracts/v1/project-takeover/takeover.json |
| `src/project-takeover.ts` | 105 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/project-topology.test.ts` | 92 | vitest test module; capture harness graph | testdata/contracts/v1/project-topology/topology.json |
| `src/project-topology.ts` | 166 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/prompt-context.test.ts` | 165 | vitest test module; capture harness graph | testdata/contracts/v1/prompt-context/context.json |
| `src/prompt-context.ts` | 161 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/proxy-project-binding.test.ts` | 87 | vitest test module; capture harness graph | testdata/contracts/v1/proxy/project-binding.json |
| `src/proxy-project-binding.ts` | 63 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/recency.ts` | 26 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/recording-cleanup.test.ts` | 156 | vitest test module; capture harness graph | testdata/contracts/v1/recordings/cleanup.json |
| `src/recording-cleanup.ts` | 179 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/recording-config.test.ts` | 36 | vitest test module; capture harness graph | testdata/contracts/v1/recordings/config.json |
| `src/recording-config.ts` | 64 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/relay-contract.ts` | 26 | app import graph; capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/release-asset-contract.test.ts` | 37 | vitest test module; capture harness graph | testdata/contracts/v1/release/asset.json |
| `src/remote-actor.ts` | 85 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/repair-events.test.ts` | 47 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/repair-events.json |
| `src/repair-events.ts` | 49 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/rich-text.test.ts` | 47 | vitest test module; capture harness graph | testdata/contracts/v1/terminal/rich-text.json |
| `src/rich-text.ts` | 162 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/runtime-coherence.test.ts` | 767 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-coherence/report.json |
| `src/runtime-coherence.ts` | 687 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/runtime-coherence/report.json<br>testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/runtime-core/agent-restore-state.test.ts` | 328 | vitest test module; capture harness graph | testdata/contracts/v1/agent-restore/state.json |
| `src/runtime-core/agent-restore-state.ts` | 666 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/runtime-core/backend-id-reconcile.test.ts` | 186 | vitest test module; capture harness graph | testdata/contracts/v1/backend-id-reconcile/reconcile.json |
| `src/runtime-core/backend-id-reconcile.ts` | 39 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/runtime-core/backend-session-ids.test.ts` | 273 | vitest test module; capture harness graph | testdata/contracts/v1/backend-session-ids/identity.json |
| `src/runtime-core/backend-session-ids.ts` | 184 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/runtime-core/exchange-alert-routing.test.ts` | 72 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-exchange/alert-routing.json |
| `src/runtime-core/exchange-alert-routing.ts` | 71 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/runtime-core/exchange-derived.ts` | 184 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/runtime-core/exchange-import.test.ts` | 209 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-exchange/import.json |
| `src/runtime-core/exchange-import.ts` | 369 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/runtime-core/exchange-retention.ts` | 480 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/runtime-core/exchange-store.test.ts` | 1263 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-exchange/store.json |
| `src/runtime-core/exchange-store.ts` | 1162 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/runtime-core/plan-authority.ts` | 104 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/runtime-core/topology-services.test.ts` | 177 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-topology/services.json |
| `src/runtime-core/topology-services.ts` | 256 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/runtime-core/topology-sessions.test.ts` | 748 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-topology/sessions.json |
| `src/runtime-core/topology-sessions.ts` | 507 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/runtime-core/topology-store.test.ts` | 693 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-topology/store.json |
| `src/runtime-core/topology-store.ts` | 776 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/runtime-core/topology-worktrees.test.ts` | 151 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-topology/worktrees.json |
| `src/runtime-core/topology-worktrees.ts` | 279 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/runtime-drift.test.ts` | 17 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/drift.json |
| `src/runtime-drift.ts` | 4 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/runtime-exchange-boundary.test.ts` | 101 | vitest test module; capture harness graph | - |
| `src/runtime-guard-repair-history.test.ts` | 102 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/guard-repair-history.json |
| `src/runtime-guard-repair-history.ts` | 90 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/runtime-migration.test.ts` | 179 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-migration/migration.json |
| `src/runtime-migration.ts` | 519 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/runtime-owner.ts` | 18 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/runtime-restart.test.ts` | 2555 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-restart/render.json |
| `src/runtime-restart.ts` | 1092 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/scribe-watcher.test.ts` | 443 | vitest test module; capture harness graph | testdata/contracts/v1/coordination/scribe-watcher.json |
| `src/scribe-watcher.ts` | 354 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/session-bootstrap-action-args.test.ts` | 143 | vitest test module; capture harness graph | testdata/contracts/v1/session-bootstrap/action-args.json |
| `src/session-bootstrap.test.ts` | 309 | vitest test module; capture harness graph | testdata/contracts/v1/session-bootstrap/preamble.json |
| `src/session-bootstrap.ts` | 627 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/session-fresh-relaunch.ts` | 34 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/session-recency.test.ts` | 48 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/session-recency.json |
| `src/session-recency.ts` | 50 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/session-restorability.test.ts` | 104 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/session-restorability.json |
| `src/session-restorability.ts` | 81 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/session-runtime.test.ts` | 56 | vitest test module; capture harness graph | testdata/contracts/v1/session/runtime.json |
| `src/session-runtime.ts` | 97 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/session-semantics.test.ts` | 166 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/session-semantics.json |
| `src/session-semantics.ts` | 333 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/dashboard/index.json |
| `src/session-viewed.test.ts` | 171 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/session-viewed.json |
| `src/session-viewed.ts` | 52 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/shell-args.test.ts` | 54 | vitest test module; capture harness graph | testdata/contracts/v1/cli/parsing.json |
| `src/shell-args.ts` | 92 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/shell-hooks.test.ts` | 155 | vitest test module; capture harness graph | testdata/contracts/v1/shell/hooks.json |
| `src/shell-hooks.ts` | 281 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/shell-state.ts` | 116 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/source-inventory-test-utils.ts` | 3 | vitest/capture support; capture harness graph; vitest dependency graph | - |
| `src/status-detector.ts` | 79 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/statusline-model.ts` | 539 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/statusline/model.json |
| `src/task-workflow.ts` | 150 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/tasks.test.ts` | 258 | vitest test module; capture harness graph | testdata/contracts/v1/coordination/tasks-threads.json |
| `src/tasks.ts` | 196 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/team.test.ts` | 45 | vitest test module; capture harness graph | testdata/contracts/v1/team/semantics.json |
| `src/team.ts` | 284 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/dashboard/session-registry.json |
| `src/terminal-host.test.ts` | 33 | vitest test module; capture harness graph | testdata/contracts/v1/terminal/host.json |
| `src/terminal-host.ts` | 56 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/threads.test.ts` | 185 | vitest test module; capture harness graph | testdata/contracts/v1/coordination/mutations.json<br>testdata/contracts/v1/coordination/tasks-threads.json |
| `src/threads.ts` | 332 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/tmux/attach-terminal-guard.test.ts` | 50 | vitest test module; capture harness graph | testdata/contracts/v1/tmux/attach-terminal-guard.json |
| `src/tmux/control-script.test.ts` | 3748 | vitest test module; capture harness graph | testdata/contracts/v1/tmux/control-script.json |
| `src/tmux/doctor.test.ts` | 213 | vitest test module; capture harness graph | testdata/contracts/v1/tmux/doctor.json |
| `src/tmux/doctor.ts` | 436 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/doctor.json<br>testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/tmux/exec-metrics.test.ts` | 190 | vitest test module; capture harness graph | testdata/contracts/v1/tmux/exec-metrics.json |
| `src/tmux/exec-metrics.ts` | 196 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/exec-metrics.json |
| `src/tmux/expose-hot-snapshot.test.ts` | 278 | vitest test module; capture harness graph | testdata/contracts/v1/tmux/expose-hot-snapshot.json |
| `src/tmux/expose-hot-snapshot.ts` | 375 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/expose-hot-snapshot.json |
| `src/tmux/expose-layout.test.ts` | 84 | vitest test module; capture harness graph | testdata/contracts/v1/tmux/expose-layout.json |
| `src/tmux/expose-model.test.ts` | 248 | vitest test module; capture harness graph | testdata/contracts/v1/tmux/expose-model.json |
| `src/tmux/expose-model.ts` | 175 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/expose-model.json |
| `src/tmux/expose-ordering.test.ts` | 224 | vitest test module | testdata/contracts/v1/tmux/expose-ordering.json |
| `src/tmux/expose-ordering.ts` | 176 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/expose-ordering.json |
| `src/tmux/expose-preview-sanitize.ts` | 19 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/expose-preview-sanitize.json |
| `src/tmux/expose-tile.test.ts` | 320 | vitest test module; capture harness graph | testdata/contracts/v1/tmux/expose-render.json |
| `src/tmux/expose-ui-state.test.ts` | 40 | vitest test module; capture harness graph | testdata/contracts/v1/tmux/expose-model.json |
| `src/tmux/expose-ui-state.ts` | 45 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/expose-model.json |
| `src/tmux/expose.test.ts` | 2672 | vitest test module | testdata/contracts/v1/tmux/expose-runner.json |
| `src/tmux/expose.ts` | 1059 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/expose-layout.json<br>testdata/contracts/v1/tmux/expose-render.json<br>testdata/contracts/v1/tmux/expose-runner.json<br>testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/tmux/query-memo.test.ts` | 193 | vitest test module; capture harness graph | testdata/contracts/v1/tmux/query-memo.json |
| `src/tmux/query-memo.ts` | 125 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/query-memo.json |
| `src/tmux/runtime-manager.test.ts` | 2142 | vitest test module | testdata/contracts/v1/tmux/client-dashboard-slot.json<br>testdata/contracts/v1/tmux/command-argv.json<br>testdata/contracts/v1/tmux/interactive-exec.json<br>testdata/contracts/v1/tmux/managed-window-lifecycle.json<br>testdata/contracts/v1/tmux/mouse-bindings-install.json<br>testdata/contracts/v1/tmux/replace-window.json<br>testdata/contracts/v1/tmux/runtime-manager-ops.json<br>testdata/contracts/v1/tmux/runtime-open-target.json<br>testdata/contracts/v1/tmux/runtime-session-lifecycle.json |
| `src/tmux/runtime-manager.ts` | 1795 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/attach-terminal-guard.json<br>testdata/contracts/v1/tmux/client-dashboard-slot.json<br>testdata/contracts/v1/tmux/command-argv.json<br>testdata/contracts/v1/tmux/interactive-exec.json<br>testdata/contracts/v1/tmux/managed-window-lifecycle.json<br>testdata/contracts/v1/tmux/mouse-bindings-install.json<br>testdata/contracts/v1/tmux/replace-window.json<br>testdata/contracts/v1/tmux/runtime-manager-ops.json<br>testdata/contracts/v1/tmux/runtime-open-target.json<br>testdata/contracts/v1/tmux/runtime-session-lifecycle.json<br>testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/tmux/runtime-stop.ts` | 28 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/runtime-stop.json<br>testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/tmux/session-names.ts` | 12 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/tmux/session-transport.test.ts` | 175 | vitest test module; capture harness graph | testdata/contracts/v1/tmux/session-transport.json |
| `src/tmux/session-transport.ts` | 152 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/session-transport.json<br>testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/tmux/startup-interstitials.test.ts` | 145 | vitest test module; capture harness graph | testdata/contracts/v1/tmux/startup-interstitials.json |
| `src/tmux/startup-interstitials.ts` | 77 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/startup-interstitials.json |
| `src/tmux/statusline-artifacts.ts` | 64 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/tmux/statusline-cache.ts` | 29 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/tmux/statusline-script.test.ts` | 58 | vitest test module; capture harness graph | testdata/contracts/v1/tmux/statusline-script.json |
| `src/tmux/statusline.test.ts` | 1104 | vitest test module | testdata/contracts/v1/tmux/statusline-render.json |
| `src/tmux/statusline.ts` | 449 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/statusline-render.json |
| `src/tmux/sync-exec-inventory.test.ts` | 188 | vitest test module; capture harness graph | testdata/contracts/v1/tmux/sync-exec-inventory.json |
| `src/tmux/window-open.test.ts` | 216 | vitest test module | testdata/contracts/v1/tmux/window-open.json |
| `src/tmux/window-open.ts` | 146 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tmux/sync-exec-inventory.json<br>testdata/contracts/v1/tmux/window-open.json |
| `src/tool-launch-defaults.ts` | 27 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/tool-output-watchers.test.ts` | 80 | vitest test module; capture harness graph | testdata/contracts/v1/runtime-state/tool-output-watchers.json |
| `src/tool-output-watchers.ts` | 122 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/transcript-turn-state.test.ts` | 184 | vitest test module; capture harness graph | testdata/contracts/v1/transcript/turn-state.json |
| `src/transcript-turn-state.ts` | 175 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/tui/render/agent-status.test.ts` | 63 | vitest test module; capture harness graph | testdata/contracts/v1/agent-status/chip.json |
| `src/tui/render/agent-status.ts` | 91 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/tui/render/box.test.ts` | 74 | vitest test module; capture harness graph | testdata/contracts/v1/tui/render-box.json |
| `src/tui/render/box.ts` | 59 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/tui/render/overlay-viewport-contract.test.ts` | 26 | vitest test module; capture harness graph | - |
| `src/tui/render/screen-frame.ts` | 92 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/tui/render/text.test.ts` | 28 | vitest test module; capture harness graph | testdata/contracts/v1/tui/render-text.json |
| `src/tui/render/text.ts` | 95 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/tui/render/theme.test.ts` | 311 | vitest test module; capture harness graph | testdata/contracts/v1/tui/render-theme.json |
| `src/tui/render/theme.ts` | 371 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/tui/screens/dashboard-renderers.test.ts` | 1204 | vitest test module; capture harness graph | testdata/contracts/v1/tui/dashboard-footer-hints.json |
| `src/tui/screens/dashboard-renderers.ts` | 987 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tui/dashboard-footer-hints.json |
| `src/tui/screens/overlay-renderers.test.ts` | 386 | vitest test module; capture harness graph | testdata/contracts/v1/tui/screen-overlays.json |
| `src/tui/screens/overlay-renderers.ts` | 605 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tui/screen-overlays.json |
| `src/tui/screens/subscreen-renderers.test.ts` | 169 | vitest test module; capture harness graph | testdata/contracts/v1/tui/subscreen-renderers.json |
| `src/tui/screens/subscreen-renderers.ts` | 764 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | testdata/contracts/v1/tui/subscreen-renderers.json |
| `src/version.test.ts` | 81 | vitest test module; capture harness graph | testdata/contracts/v1/release/version.json |
| `src/version.ts` | 28 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/visual-client-leases.test.ts` | 76 | vitest test module; capture harness graph | testdata/contracts/v1/visual-client-leases/leases.json |
| `src/visual-client-leases.ts` | 113 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/vitest.setup.ts` | 14 | vitest/capture support; vitest dependency graph | - |
| `src/work-outline.test.ts` | 167 | vitest test module; capture harness graph | testdata/contracts/v1/work-outline/outline.json |
| `src/work-outline.ts` | 270 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/workflow.test.ts` | 141 | vitest test module; capture harness graph | testdata/contracts/v1/workflow/entries.json |
| `src/workflow.ts` | 180 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/worktree-cache-cleanup.test.ts` | 151 | vitest test module; capture harness graph | testdata/contracts/v1/worktree/cache-cleanup.json |
| `src/worktree-cache-cleanup.ts` | 411 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/worktree-colors.test.ts` | 107 | vitest test module; capture harness graph | testdata/contracts/v1/worktrees/colors.json |
| `src/worktree-colors.ts` | 107 | app import graph; capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |
| `src/worktree.test.ts` | 106 | vitest test module; capture harness graph | testdata/contracts/v1/worktree/state.json |
| `src/worktree.ts` | 280 | capture harness graph; source-checkout/dev entry graph; vitest dependency graph | - |

## Method Notes

- Static import graph handles relative `import`, `export ... from`, dynamic string `import()`, and string `require()` forms inside `src/`. `.js` specifiers are normalized back to `.ts`/`.tsx` source files.
- App roots are direct relative imports from `app/**/*.{ts,tsx,js,jsx}` into `src/`, followed through `src` imports.
- Capture roots are literal `src/**/*.ts` references in `scripts/capture*.mjs`, followed through `src` imports.
- Vitest keeps include `*.test.ts`, `*-test-utils.ts`, `test-utils.ts`, `src/vitest.setup.ts`, and their `src` dependency closure.
- Behavior proof excludes source-boundary-only proof because that corpus proves static boundary policy, not replacement behavior.
