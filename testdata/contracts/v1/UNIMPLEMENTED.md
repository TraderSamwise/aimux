# Unimplemented Contract Consumers

This inventory lists fixture consumers that load captured TypeScript contract
corpora but are intentionally `#[ignore]` because the matching Rust API does
not exist yet or the implementation sits behind an ownership fence.

Coverage definition used for this inventory: a `src` test module is covered when
any `testdata/contracts/v1/**/*.json` fixture records that module in a top-level
`source`, top-level `sources`, case `source`, or group/case `source` field.
Under that definition there are 245 `src` test modules, 187 covered modules, and
58 uncovered modules remaining. The older 196-uncovered baseline is stale; from
that baseline, 138 modules have been covered.

There are 29 ignored corpus entries below, covering 162 captured checklist
cases.

| Consumer | Corpus | Cases | Missing Rust API | Ownership fence |
| --- | --- | ---: | --- | --- |
| `fixture_agent_io_methods.rs` | `testdata/contracts/v1/agent-output/io-methods.json` | 1 | `agentIoMethods.deliverOrchestrationMessage` orchestration-delivery API | No explicit fence; needs a new public Rust API for the multiplexer agent-I/O helper |
| `fixture_cli_wrappers.rs` | `testdata/contracts/v1/cli/metadata-command.json` | 4 | `serviceMetadataFromUrls` / `registerMetadataCommand` CLI wrapper behavior | `core_cli*` |
| `fixture_cli_wrappers.rs` | `testdata/contracts/v1/cli/logs-command.json` | 4 | `registerLogsCommand` CLI wrapper behavior | `core_cli*` |
| `fixture_cli_wrappers.rs` | `testdata/contracts/v1/cli/work-outline-command.json` | 4 | `renderWorkOutlineEntries` / `registerWorkOutlineCommand` CLI wrapper behavior | `core_cli*` |
| `fixture_coordination_mutations.rs` | `testdata/contracts/v1/coordination/mutations.json` | 4 | Direct `threads.ts` compatibility helpers for thread creation/reply/reuse | No explicit fence for helper API; route exposure may touch `project_service/routes/` |
| `fixture_core_command_behavior.rs` | `testdata/contracts/v1/core-command/behavior.json` | 6 | `AimuxDaemon.routeRequest` daemon-route behavior | `daemon_*` |
| `fixture_dashboard_api_client.rs` | `testdata/contracts/v1/runtime-state/dashboard-api-client.json` | 8 | Dashboard API client URL/response projection helpers | `dashboard_*` |
| `fixture_dashboard_lifecycle.rs` | `testdata/contracts/v1/runtime-state/dashboard-lifecycle.json` | 9 | Dashboard lifecycle guard behavior | `dashboard_*` |
| `fixture_dashboard_model_service.rs` | `testdata/contracts/v1/runtime-state/dashboard-model-service.json` | 11 | `refreshDashboardModelFromService` runtime dashboard-model update API | `dashboard_*` |
| `fixture_dashboard_navigation.rs` | `testdata/contracts/v1/runtime-state/dashboard-navigation.json` | 1 | `showMigratePicker` navigation decision API | `dashboard_*` |
| `fixture_dashboard_repair_notices.rs` | `testdata/contracts/v1/runtime-state/dashboard-repair-notices.json` | 1 | `recordDashboardRepairNotice` runtime notice-store behavior | `dashboard_*` |
| `fixture_dashboard_ui_state_store.rs` | `testdata/contracts/v1/runtime-state/dashboard-ui-state-store.json` | 12 | `DashboardUiStateStore` persistence/projection API | `dashboard_*` |
| `fixture_debug_lifecycle_log.rs` | `testdata/contracts/v1/debug/lifecycle-log.json` | 3 | `logLifecycleAlways` logging API and event formatting | No explicit fence; needs Rust logging subsystem parity surface |
| `fixture_event_loop.rs` | `testdata/contracts/v1/event-loop/metrics.json` | 3 | Event-loop delay histogram lifecycle APIs | `daemon_*` |
| `fixture_hotkeys.rs` | `testdata/contracts/v1/terminal/hotkeys.json` | 2 | Global leader hotkey parser/handler API | `dashboard_*` / terminal-control runtime |
| `fixture_inbox_cleanup_runtime.rs` | `testdata/contracts/v1/notifications/inbox-cleanup-runtime.json` | 2 | `persistenceMethods.cleanupInbox` dashboard refresh side effects | `dashboard_*` |
| `fixture_installed_shim.rs` | `testdata/contracts/v1/release/installed-shim.json` | 3 | Installed shell shim contract reader/executor | No explicit fence; release/install shell artifact, no Rust public API |
| `fixture_key_parser.rs` | `testdata/contracts/v1/terminal/key-parser.json` | 5 | General terminal `parseKeys` / `KeyEvent` parser API | `dashboard_*` / terminal-control runtime |
| `fixture_package_manifest.rs` | `testdata/contracts/v1/release/package-manifest.json` | 1 | `package.json` release file-list contract reader | No explicit fence; release/package metadata, no Rust public API |
| `fixture_plugin_runtime.rs` | `testdata/contracts/v1/plugin/runtime.json` | 4 | Bundled wrapper seeding and `PluginRuntime.start` user-plugin startup status APIs | No explicit fence; needs plugin runtime source port |
| `fixture_project_event_stream.rs` | `testdata/contracts/v1/runtime-state/project-event-stream.json` | 22 | `DashboardProjectEventAdapter` event-stream projection API | `dashboard_*` / TUI runtime |
| `fixture_project_scanner.rs` | `testdata/contracts/v1/project-catalog/scanner.json` | 8 | `scanProject`, desktop project registry, and discovery APIs | `daemon_*` / project catalog |
| `fixture_project_takeover.rs` | `testdata/contracts/v1/project-takeover/takeover.json` | 5 | `takeOverProjectFromOtherOwners` side-effect API | `daemon_*` / project ownership |
| `fixture_release_asset.rs` | `testdata/contracts/v1/release/asset.json` | 3 | Release asset packaging contract reader/executor | No explicit fence; release shell packaging, no Rust public API |
| `fixture_rich_text.rs` | `testdata/contracts/v1/terminal/rich-text.json` | 6 | `parseSgrRichTextLines`, `richTextLineText`, and `richTextText` helpers | Terminal/control/render; likely `dashboard_*` if wired through dashboard surfaces |
| `fixture_terminal_host.rs` | `testdata/contracts/v1/terminal/host.json` | 2 | `TerminalHost` escape-sequence handling API | Terminal/control/render; likely `tmux*` / `dashboard_*` |
| `fixture_transcript_reconciler.rs` | `testdata/contracts/v1/agent-output/transcript-reconciler.json` | 13 | `TranscriptReconciler.scan` incremental transcript reconciliation API | No explicit fence; needs multiplexer transcript reconciler API |
| `fixture_tui_runtime_mutations.rs` | `testdata/contracts/v1/runtime-state/tui-runtime-mutations.json` | 9 | TUI mutation queue helpers for notifications, session seen, and queue clearing | `dashboard_*` / TUI runtime |
| `fixture_version_contract.rs` | `testdata/contracts/v1/release/version.json` | 6 | Installed artifact version/build-profile readers | No explicit fence; release/install metadata, no Rust public API |
