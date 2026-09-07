# Unimplemented Contract Consumers

This inventory lists real captured TypeScript contract corpora that are intentionally `#[ignore]` because the matching Rust API does not exist yet, the implementation sits behind an ownership fence, or the existing fenced Rust implementation currently differs from the captured TypeScript behavior. It deliberately does not count Vitest reporter output as coverage.

Coverage definition used for this inventory: a `src` test module is covered when any `testdata/contracts/v1/**/*.json` fixture records that module in a top-level `source`, top-level `sources`, case `source`, or group/case `source` field, and the fixture contains behavior-level input/output or state data rather than test-runner metadata. Under that definition there are 245 `src` test modules, 245 covered modules, and 0 uncovered modules remaining.

There are 11 ignored corpus entries below, covering 41 captured checklist cases.

| Consumer | Corpus | Cases | Missing Rust API / parity bug | Ownership fence |
| --- | --- | ---: | --- | --- |
| `fixture_cli_wrappers.rs` | `testdata/contracts/v1/cli/metadata-command.json` | 4 | serviceMetadataFromUrls / registerMetadataCommand CLI wrapper behavior | core_cli* |
| `fixture_cli_wrappers.rs` | `testdata/contracts/v1/cli/logs-command.json` | 4 | registerLogsCommand CLI wrapper behavior | core_cli* |
| `fixture_cli_wrappers.rs` | `testdata/contracts/v1/cli/work-outline-command.json` | 4 | renderWorkOutlineEntries / registerWorkOutlineCommand CLI wrapper behavior | core_cli* |
| `fixture_core_command_ownership.rs` | `testdata/contracts/v1/core-command/ownership.json` | 3 | Parity bug: Rust core_cli_routing claims dashboard-reload/restart-runtime commands that TypeScript leaves on the full CLI path | core_cli* |
| `fixture_dashboard_navigation.rs` | `testdata/contracts/v1/runtime-state/dashboard-navigation.json` | 1 | showMigratePicker navigation decision API | dashboard_* |
| `fixture_dashboard_repair_notices.rs` | `testdata/contracts/v1/runtime-state/dashboard-repair-notices.json` | 1 | recordDashboardRepairNotice runtime notice-store behavior | dashboard_* |
| `fixture_desktop_state_golden.rs` | `testdata/contracts/v1/dashboard/desktop-state-golden.json` | 4 | Parity bug: Rust dashboard model serialization adds default false fields and drops TS null/extra fields from captured `buildDesktopStateSnapshot` output | dashboard_* |
| `fixture_multiplexer_notifications.rs` | `testdata/contracts/v1/multiplexer/notifications.json` | 5 | dashboard notification host helpers for coordination projection, target labels/states, and mutation input shape | dashboard_* |
| `fixture_project_takeover.rs` | `testdata/contracts/v1/project-takeover/takeover.json` | 5 | takeOverProjectFromOtherOwners side-effect API | daemon_* / project ownership |
| `fixture_rich_text.rs` | `testdata/contracts/v1/terminal/rich-text.json` | 6 | parseSgrRichTextLines, richTextLineText, and richTextText helpers | Terminal/control/render; likely dashboard_* if wired through dashboard surfaces |
| `fixture_tmux_doctor_contract.rs` | `testdata/contracts/v1/tmux/doctor.json` | 4 | tmux doctor report and repair APIs | tmux* / daemon_* |

## Honest Uncovered Gaps

No uncovered `src/**/*.test.ts` modules remain under this coverage definition.
