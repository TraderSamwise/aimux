# Rust Translation Parity Matrix v1

Statuses: `not-started`, `contract-locked`, `rust-mirrored`,
`dual-run-passing`, `rust-owned`, `ts-retired`, `blocked`.

| ID | Surface | TS Owner | Contract/Fixture | Required Tests | Rust Status | Evidence | Last Commit | Gaps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CLI-001 | `aimux ps` text/json | `src/main.ts`, `src/core-command-contract.ts` | pending | pending | not-started | none | none | capture stdout/stderr/status |
| CLI-002 | daemon lifecycle commands | `src/main.ts`, `src/daemon.ts` | pending | pending | not-started | none | none | capture status/ensure/restart behavior |
| API-001 | project API route list | `src/project-api-contract.ts` | `testdata/contracts/v1/project-api/routes.json` | pending | contract-locked | seed fixture added | none | fill generated route list |
| API-002 | project SSE events | `src/metadata-server.ts`, `app/lib/heartbeat.ts` | pending | pending | not-started | none | none | capture ready/update/error frames |
| TMUX-001 | tmux command argv | `src/tmux/runtime-manager.ts` | `testdata/contracts/v1/tmux/command-argv.json` | pending | contract-locked | seed fixture added | none | expand cases |
| TMUX-002 | tmux metadata and topology | `src/tmux/*`, `src/runtime-core/topology-store.ts` | pending | pending | not-started | none | none | capture option names and YAML schema |
| DASH-001 | desktop-state snapshot | `src/multiplexer/dashboard-model.ts` | `testdata/contracts/v1/dashboard/desktop-state-counts.json` | pending | contract-locked | seed fixture added | none | export golden fixture cases |
| OUT-001 | ANSI SGR spans | `app/lib/ansi.ts` | `testdata/contracts/v1/ansi/sgr-spans.json` | pending | contract-locked | seed fixture added | none | add expected spans |
| OUT-002 | agent output parser | `src/agent-output-parser.ts` | `testdata/contracts/v1/agent-output/parser-adversarial.json` | pending | contract-locked | seed fixture added | none | export curated fixtures |
| CAT-001 | project catalog scanning | `src/project-scanner.ts` | `testdata/contracts/v1/project-catalog/registry.json` | pending | contract-locked | seed fixture added | none | add mixed registry cases |
| REL-001 | native release has zero Node CLI | `bin/aimux`, `scripts/install.sh` | pending | pending | not-started | none | none | add release asset inspection |
