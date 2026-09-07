# Unimplemented Contract Consumers

This inventory lists real captured TypeScript contract corpora that are intentionally `#[ignore]` because the matching Rust API does not exist yet, the implementation sits behind an ownership fence, or the existing fenced Rust implementation currently differs from the captured TypeScript behavior. It deliberately does not count Vitest reporter output as coverage.

Coverage definition used for this inventory: a `src` test module is covered when any `testdata/contracts/v1/**/*.json` fixture records that module in a top-level `source`, top-level `sources`, case `source`, or group/case `source` field, and the fixture contains behavior-level input/output or state data rather than test-runner metadata. Under that definition there are 245 `src` test modules, 239 covered modules, and 6 uncovered modules remaining.

There are 37 ignored corpus entries below, covering 188 captured checklist cases.

| Consumer | Corpus | Cases | Missing Rust API / parity bug | Ownership fence |
| --- | --- | ---: | --- | --- |
| `fixture_agent_io_methods.rs` | `testdata/contracts/v1/agent-output/io-methods.json` | 1 | agentIoMethods.deliverOrchestrationMessage orchestration-delivery API | No explicit fence; needs a new public Rust API for the multiplexer agent-I/O helper |
| `fixture_cli_wrappers.rs` | `testdata/contracts/v1/cli/metadata-command.json` | 4 | serviceMetadataFromUrls / registerMetadataCommand CLI wrapper behavior | core_cli* |
| `fixture_cli_wrappers.rs` | `testdata/contracts/v1/cli/logs-command.json` | 4 | registerLogsCommand CLI wrapper behavior | core_cli* |
| `fixture_cli_wrappers.rs` | `testdata/contracts/v1/cli/work-outline-command.json` | 4 | renderWorkOutlineEntries / registerWorkOutlineCommand CLI wrapper behavior | core_cli* |
| `fixture_coordination_mutations.rs` | `testdata/contracts/v1/coordination/mutations.json` | 6 | Direct threads.ts compatibility helpers for thread creation/reply/reuse | No explicit fence for helper API; route exposure may touch project_service/routes/ |
| `fixture_core_command_behavior.rs` | `testdata/contracts/v1/core-command/behavior.json` | 6 | AimuxDaemon.routeRequest daemon-route behavior | daemon_* |
| `fixture_core_command_ownership.rs` | `testdata/contracts/v1/core-command/ownership.json` | 3 | Parity bug: Rust core_cli_routing claims dashboard-reload/restart-runtime commands that TypeScript leaves on the full CLI path | core_cli* |
| `fixture_dashboard_navigation.rs` | `testdata/contracts/v1/runtime-state/dashboard-navigation.json` | 1 | showMigratePicker navigation decision API | dashboard_* |
| `fixture_dashboard_command_spec.rs` | `testdata/contracts/v1/dashboard/command-spec.json` | 9 | Parity bug: TypeScript dashboard command spec launches the legacy Node dashboard while Rust launches the native dashboard | dashboard_* |
| `fixture_dashboard_repair_notices.rs` | `testdata/contracts/v1/runtime-state/dashboard-repair-notices.json` | 1 | recordDashboardRepairNotice runtime notice-store behavior | dashboard_* |
| `fixture_dashboard_targets.rs` | `testdata/contracts/v1/dashboard/targets.json` | 4 | dashboard target discovery/replacement APIs over mocked tmux | dashboard_* / tmux* |
| `fixture_desktop_state_golden.rs` | `testdata/contracts/v1/dashboard/desktop-state-golden.json` | 4 | Parity bug: Rust dashboard model serialization adds default false fields and drops TS null/extra fields from captured `buildDesktopStateSnapshot` output | dashboard_* |
| `fixture_debug_lifecycle_log.rs` | `testdata/contracts/v1/debug/lifecycle-log.json` | 3 | logLifecycleAlways logging API and event formatting | No explicit fence; needs Rust logging subsystem parity surface |
| `fixture_event_loop.rs` | `testdata/contracts/v1/event-loop/metrics.json` | 3 | Event-loop delay histogram lifecycle APIs | daemon_* |
| `fixture_hotkeys.rs` | `testdata/contracts/v1/terminal/hotkeys.json` | 2 | Global leader hotkey parser/handler API | dashboard_* / terminal-control runtime |
| `fixture_inbox_cleanup_runtime.rs` | `testdata/contracts/v1/notifications/inbox-cleanup-runtime.json` | 2 | persistenceMethods.cleanupInbox dashboard refresh side effects | dashboard_* |
| `fixture_installed_shim.rs` | `testdata/contracts/v1/release/installed-shim.json` | 3 | Installed shell shim contract reader/executor | No explicit fence; release/install shell artifact, no Rust public API |
| `fixture_key_parser.rs` | `testdata/contracts/v1/terminal/key-parser.json` | 5 | General terminal parseKeys / KeyEvent parser API | dashboard_* / terminal-control runtime |
| `fixture_multiplexer_dashboard_state_helpers.rs` | `testdata/contracts/v1/multiplexer/dashboard-state-helpers.json` | 7 | archives, dashboard-tail-methods, dashboard-view-methods, persistence-methods, and runtime-state helper APIs | dashboard_* / tmux* |
| `fixture_multiplexer_resource_refresh.rs` | `testdata/contracts/v1/multiplexer/library-refresh.json` | 6 | library resource refresh runtime state machine | dashboard_* |
| `fixture_multiplexer_notifications.rs` | `testdata/contracts/v1/multiplexer/notifications.json` | 5 | dashboard notification host helpers for coordination projection, target labels/states, and mutation input shape | dashboard_* |
| `fixture_multiplexer_resource_refresh.rs` | `testdata/contracts/v1/multiplexer/project-refresh.json` | 6 | project observability refresh runtime state machine | dashboard_* |
| `fixture_multiplexer_runtime_helpers.rs` | `testdata/contracts/v1/multiplexer/runtime-helpers.json` | 10 | dashboard-control, dashboard-ops, session-launch, session-runtime-core, and subscreen helper APIs | dashboard_* / tmux* / session_launch.rs |
| `fixture_multiplexer_resource_refresh.rs` | `testdata/contracts/v1/multiplexer/topology-refresh.json` | 6 | topology refresh runtime state machine | dashboard_* |
| `fixture_package_manifest.rs` | `testdata/contracts/v1/release/package-manifest.json` | 1 | package.json release file-list contract reader | No explicit fence; release/package metadata, no Rust public API |
| `fixture_plugin_runtime.rs` | `testdata/contracts/v1/plugin/runtime.json` | 8 | Bundled wrapper seeding and PluginRuntime.start user-plugin startup status APIs | No explicit fence; needs plugin runtime source port |
| `fixture_project_scanner.rs` | `testdata/contracts/v1/project-catalog/scanner.json` | 8 | scanProject, desktop project registry, and discovery APIs | daemon_* / project catalog |
| `fixture_project_takeover.rs` | `testdata/contracts/v1/project-takeover/takeover.json` | 5 | takeOverProjectFromOtherOwners side-effect API | daemon_* / project ownership |
| `fixture_release_asset.rs` | `testdata/contracts/v1/release/asset.json` | 3 | Release asset packaging contract reader/executor | No explicit fence; release shell packaging, no Rust public API |
| `fixture_rich_text.rs` | `testdata/contracts/v1/terminal/rich-text.json` | 6 | parseSgrRichTextLines, richTextLineText, and richTextText helpers | Terminal/control/render; likely dashboard_* if wired through dashboard surfaces |
| `fixture_terminal_host.rs` | `testdata/contracts/v1/terminal/host.json` | 2 | TerminalHost escape-sequence handling API | Terminal/control/render; likely tmux* / dashboard_* |
| `fixture_transcript_reconciler.rs` | `testdata/contracts/v1/agent-output/transcript-reconciler.json` | 13 | TranscriptReconciler.scan incremental transcript reconciliation API | No explicit fence; needs multiplexer transcript reconciler API |
| `fixture_tmux_doctor_contract.rs` | `testdata/contracts/v1/tmux/doctor.json` | 4 | tmux doctor report and repair APIs | tmux* / daemon_* |
| `fixture_tui_runtime_mutations.rs` | `testdata/contracts/v1/runtime-state/tui-runtime-mutations.json` | 9 | TUI mutation queue helpers for notifications, session seen, and queue clearing | dashboard_* / TUI runtime |
| `fixture_tui_screen_renderers.rs` | `testdata/contracts/v1/tui/screen-overlays.json` | 13 | TypeScript TUI overlay renderer APIs | dashboard_* / terminal/control/render |
| `fixture_tui_screen_renderers.rs` | `testdata/contracts/v1/tui/subscreen-renderers.json` | 5 | TypeScript TUI subscreen renderer APIs | dashboard_* / terminal/control/render |
| `fixture_version_contract.rs` | `testdata/contracts/v1/release/version.json` | 6 | Installed artifact version/build-profile readers | No explicit fence; release/install metadata, no Rust public API |

## Honest Uncovered Gaps

These `src/**/*.test.ts` modules still have no behavior-level corpus under `testdata/contracts/v1`. They remain uncovered until a real fixture records inputs, outputs, and side effects, or until an explicit uncapturable rationale is accepted.

| Source module | Reason real corpus is still missing | Ownership fence |
| --- | --- | --- |
| `src/core-cli.test.ts` | Core CLI end-to-end sidecar runner; needs per-command input/output capture from runCoreCli, not Vitest reporter metadata. | core_cli* |
| `src/core-project-actor.test.ts` | Child-process lifecycle supervisor integration; no pure captured API selected yet. | daemon_* / project actor lifecycle |
| `src/daemon.test.ts` | Daemon HTTP/core-command/expose/project actor integration; no pure captured API selected yet. | daemon_* |
| `src/full/hosted-server.test.ts` | Hosted proxy server integration; needs route request/response corpus rather than test names. | daemon_* / hosted service |
| `src/metadata-server.interaction.test.ts` | Project-service interaction HTTP API; needs request/response corpus. | project_service/routes/ |
| `src/metadata-server.test.ts` | Project-service metadata HTTP routes; needs request/response corpus. | project_service/routes/ |
