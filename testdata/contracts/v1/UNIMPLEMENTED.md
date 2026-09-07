# Unimplemented Contract Consumers

This inventory lists fixture consumers that load captured TypeScript contract corpora but are intentionally `#[ignore]` because the matching Rust API does not exist yet or the implementation sits behind an ownership fence.

Coverage definition used for this inventory: a `src` test module is covered when any `testdata/contracts/v1/**/*.json` fixture records that module in a top-level `source`, top-level `sources`, case `source`, or group/case `source` field. Under that definition there are 245 `src` test modules, 245 covered modules, and 0 uncovered modules remaining.

There are 55 ignored corpus entries below, covering 1190 captured checklist cases.

| Consumer | Corpus | Cases | Missing Rust API | Ownership fence |
| --- | --- | ---: | --- | --- |
| `fixture_agent_io_methods.rs` | `testdata/contracts/v1/agent-output/io-methods.json` | 1 | agentIoMethods.deliverOrchestrationMessage orchestration-delivery API | No explicit fence; needs a new public Rust API for the multiplexer agent-I/O helper |
| `fixture_cli_wrappers.rs` | `testdata/contracts/v1/cli/metadata-command.json` | 4 | serviceMetadataFromUrls / registerMetadataCommand CLI wrapper behavior | core_cli* |
| `fixture_cli_wrappers.rs` | `testdata/contracts/v1/cli/logs-command.json` | 4 | registerLogsCommand CLI wrapper behavior | core_cli* |
| `fixture_cli_wrappers.rs` | `testdata/contracts/v1/cli/work-outline-command.json` | 4 | renderWorkOutlineEntries / registerWorkOutlineCommand CLI wrapper behavior | core_cli* |
| `fixture_coordination_mutations.rs` | `testdata/contracts/v1/coordination/mutations.json` | 6 | Direct threads.ts compatibility helpers for thread creation/reply/reuse | No explicit fence for helper API; route exposure may touch project_service/routes/ |
| `fixture_core_command_behavior.rs` | `testdata/contracts/v1/core-command/behavior.json` | 6 | AimuxDaemon.routeRequest daemon-route behavior | daemon_* |
| `fixture_dashboard_navigation.rs` | `testdata/contracts/v1/runtime-state/dashboard-navigation.json` | 1 | showMigratePicker navigation decision API | dashboard_* |
| `fixture_dashboard_repair_notices.rs` | `testdata/contracts/v1/runtime-state/dashboard-repair-notices.json` | 1 | recordDashboardRepairNotice runtime notice-store behavior | dashboard_* |
| `fixture_debug_lifecycle_log.rs` | `testdata/contracts/v1/debug/lifecycle-log.json` | 3 | logLifecycleAlways logging API and event formatting | No explicit fence; needs Rust logging subsystem parity surface |
| `fixture_event_loop.rs` | `testdata/contracts/v1/event-loop/metrics.json` | 3 | Event-loop delay histogram lifecycle APIs | daemon_* |
| `fixture_hotkeys.rs` | `testdata/contracts/v1/terminal/hotkeys.json` | 2 | Global leader hotkey parser/handler API | dashboard_* / terminal-control runtime |
| `fixture_inbox_cleanup_runtime.rs` | `testdata/contracts/v1/notifications/inbox-cleanup-runtime.json` | 2 | persistenceMethods.cleanupInbox dashboard refresh side effects | dashboard_* |
| `fixture_installed_shim.rs` | `testdata/contracts/v1/release/installed-shim.json` | 3 | Installed shell shim contract reader/executor | No explicit fence; release/install shell artifact, no Rust public API |
| `fixture_key_parser.rs` | `testdata/contracts/v1/terminal/key-parser.json` | 5 | General terminal parseKeys / KeyEvent parser API | dashboard_* / terminal-control runtime |
| `fixture_package_manifest.rs` | `testdata/contracts/v1/release/package-manifest.json` | 1 | package.json release file-list contract reader | No explicit fence; release/package metadata, no Rust public API |
| `fixture_plugin_runtime.rs` | `testdata/contracts/v1/plugin/runtime.json` | 8 | Bundled wrapper seeding and PluginRuntime.start user-plugin startup status APIs | No explicit fence; needs plugin runtime source port |
| `fixture_project_scanner.rs` | `testdata/contracts/v1/project-catalog/scanner.json` | 8 | scanProject, desktop project registry, and discovery APIs | daemon_* / project catalog |
| `fixture_project_takeover.rs` | `testdata/contracts/v1/project-takeover/takeover.json` | 5 | takeOverProjectFromOtherOwners side-effect API | daemon_* / project ownership |
| `fixture_release_asset.rs` | `testdata/contracts/v1/release/asset.json` | 3 | Release asset packaging contract reader/executor | No explicit fence; release shell packaging, no Rust public API |
| `fixture_rich_text.rs` | `testdata/contracts/v1/terminal/rich-text.json` | 6 | parseSgrRichTextLines, richTextLineText, and richTextText helpers | Terminal/control/render; likely dashboard_* if wired through dashboard surfaces |
| `fixture_terminal_host.rs` | `testdata/contracts/v1/terminal/host.json` | 2 | TerminalHost escape-sequence handling API | Terminal/control/render; likely tmux* / dashboard_* |
| `fixture_transcript_reconciler.rs` | `testdata/contracts/v1/agent-output/transcript-reconciler.json` | 13 | TranscriptReconciler.scan incremental transcript reconciliation API | No explicit fence; needs multiplexer transcript reconciler API |
| `fixture_tui_runtime_mutations.rs` | `testdata/contracts/v1/runtime-state/tui-runtime-mutations.json` | 9 | TUI mutation queue helpers for notifications, session seen, and queue clearing | dashboard_* / TUI runtime |
| `fixture_version_contract.rs` | `testdata/contracts/v1/release/version.json` | 6 | Installed artifact version/build-profile readers | No explicit fence; release/install metadata, no Rust public API |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 27 | src/core-cli.test.ts: Core CLI end-to-end runner and sidecar command execution harness | core_cli* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 3 | src/core-command-ownership.test.ts: Core command ownership inventory and installed-shim dispatch parity API | core_cli* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 7 | src/core-project-actor.test.ts: Project actor child-process lifecycle supervisor | daemon_* / project service actor lifecycle |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 154 | src/daemon.test.ts: Daemon HTTP/core-command/expose/project-actor integration surface | daemon_* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 5 | src/daemon/projects-route.test.ts: Daemon projects route count/cache projection API | daemon_* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 15 | src/dashboard/command-spec.test.ts: Dashboard command spec compatibility surface for legacy Node dashboard launcher | dashboard_* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 4 | src/dashboard/targets.test.ts: Dashboard target resolution tmux ownership/focus API | dashboard_* / tmux* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 46 | src/full/hosted-server.test.ts: Hosted server proxy/rate-limit/audit integration API | daemon_* / hosted service |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 15 | src/metadata-server.interaction.test.ts: Project-service interaction request/watch/respond HTTP API | project_service/routes/ |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 198 | src/metadata-server.test.ts: Project-service metadata HTTP route integration API | project_service/routes/ |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 14 | src/multiplexer/archives.test.ts: Dashboard archive/graveyard TUI API runtime methods | dashboard_* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 89 | src/multiplexer/dashboard-control.test.ts: Dashboard control-plane recovery, endpoint validation, and focus API | dashboard_* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 85 | src/multiplexer/dashboard-interaction.test.ts: Dashboard keyboard interaction state machine | dashboard_* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 66 | src/multiplexer/dashboard-ops.test.ts: Dashboard service/session operation state machine | dashboard_* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 37 | src/multiplexer/dashboard-tail-methods.test.ts: Dashboard tail/heartbeat/stream lifecycle methods | dashboard_* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 16 | src/multiplexer/dashboard-view-methods.test.ts: Dashboard view refresh and stale-render suppression methods | dashboard_* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 4 | src/multiplexer/desktop-state-golden.test.ts: Desktop-state golden snapshot generator parity API | dashboard_* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 10 | src/multiplexer/library.test.ts: Dashboard library screen service-backed model API | dashboard_* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 21 | src/multiplexer/notifications.test.ts: Dashboard notification screen mutation/refresh API | dashboard_* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 38 | src/multiplexer/persistence-methods.test.ts: Dashboard persistence mutation methods and stale completion guards | dashboard_* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 10 | src/multiplexer/project.test.ts: Dashboard project screen service-backed model API | dashboard_* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 65 | src/multiplexer/runtime-state.test.ts: Dashboard runtime-state refresh, restore, backend-id, and idle notification API | dashboard_* / tmux* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 63 | src/multiplexer/session-launch.test.ts: Managed tmux session launch/resume/relaunch implementation | tmux* / session_launch.rs |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 41 | src/multiplexer/session-runtime-core.test.ts: Managed tmux session runtime core implementation | tmux* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 9 | src/multiplexer/subscreens.test.ts: Dashboard coordination/archive subscreen state machine | dashboard_* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 9 | src/multiplexer/topology.test.ts: Dashboard topology screen service-backed model API | dashboard_* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 3 | src/tmux/attach-terminal-guard.test.ts: tmux attach terminal guard and attach command API | tmux* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 4 | src/tmux/doctor.test.ts: tmux doctor compatibility report and repair API | tmux* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 5 | src/tmux/sync-exec-inventory.test.ts: tmux synchronous execution source-inventory guard | tmux* |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 13 | src/tui/screens/overlay-renderers.test.ts: TUI overlay renderer compatibility API | dashboard_* / terminal/control/render |
| `fixture_unimplemented_src_modules.rs` | `testdata/contracts/v1/unimplemented/src-modules.json` | 8 | src/tui/screens/subscreen-renderers.test.ts: TUI subscreen renderer compatibility API | dashboard_* / terminal/control/render |
