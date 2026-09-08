# Rust Translation Phase Log v1

## 2026-09-05 Phase 0

Status: complete
Scope: native workspace, initial native CLI, parity contract map, shared fixture
root, and progress tracking.

Verification:
- `yarn native:fmt:check`
- `yarn native:test`
- `cargo run --manifest-path native/Cargo.toml -p aimux -- rewrite status --json`

Parity evidence:
- `native/contracts/feature-parity-v1.json`
- `testdata/contracts/v1/`

Open gaps:
- Phase 1 must fill generated TypeScript oracle fixtures before porting models.

## 2026-09-05 Phase 1 Pure Contracts

Status: complete
Scope: `src/project-api-contract.ts` and `src/core-command-contract.ts`
route/name constants plus project API invalidation logic.

Verification:
- `yarn native:fmt`
- `yarn native:test`
- TypeScript export differential check for project routes, core routes, and core commands
- Subagent review found no exact contract mismatches

Parity evidence:
- `testdata/contracts/v1/project-api/routes.json`
- `testdata/contracts/v1/core-command/routes.json`
- `testdata/contracts/v1/core-command/commands.json`

Open gaps:
- Full request/response struct mirror remains for later Phase 1 slices.

## 2026-09-05 Phase 1 Path Identity

Status: complete
Scope: `src/paths.ts` deterministic project identity helpers, AIMUX_HOME
resolution, managed worktree parent identity, and read-only project path
projection.

Verification:
- `yarn native:test`
- `/Users/sam/cs/aimux/node_modules/.bin/tsc -p tsconfig.json`
- direct Node oracle for `getProjectIdFor` and `getReadOnlyProjectPathsFor`

Parity evidence:
- `testdata/contracts/v1/paths/identity.json`
- TypeScript oracle confirmed project id, managed worktree identity,
  read-only paths, and non-git fallback cache behavior

Open gaps:
- Registry mutation, corrupt-file quarantine, and AsyncLocalStorage-equivalent
  scoped project path state remain for later Phase 1/daemon slices.

## 2026-09-05 Phase 1 Config Semantics

Status: complete
Scope: `src/config.ts` defaults, object-only deep merge, pure global/project
layering, project stripping of global-only `hosted` and `installs` blocks, and
normalization for worktrees, loop, scribe, expose, Codex, and Claude resume
arguments.

Verification:
- `yarn native:fmt`
- `yarn native:test`
- `cargo clippy --manifest-path native/Cargo.toml --all-targets -- -D warnings`
- `/Users/sam/cs/aimux/node_modules/.bin/tsc -p tsconfig.json`
- direct TypeScript `loadConfig({ includeGlobal: false })` oracle comparison
  against `testdata/contracts/v1/config/default.json`
- direct TypeScript oracle for representative scribe, worktree cleanup,
  expose, and built-in resume normalization cases

Parity evidence:
- `testdata/contracts/v1/config/default.json`
- focused Rust tests translated from `src/config.test.ts`
- subagent review found JS-edge drift around malformed arrays/scalars/null;
  patched with additional Rust tests before commit

Open gaps:
- Filesystem loading, corrupt-file quarantine, and config save/init behavior
  remain TypeScript-owned.

## 2026-09-05 Phase 1 Registered Catalog And Projects Route

Status: complete
Scope: `src/project-scanner.ts` registered desktop project filtering/sorting and
`src/daemon/projects-route.ts` registered `/projects` service decoration plus
online agent count rules.

Verification:
- `yarn native:test`
- direct TypeScript oracle for `countOnlineDesktopAgents`

Parity evidence:
- focused Rust tests translated from `src/project-scanner.test.ts` and
  `src/daemon/projects-route.test.ts`
- dead-code sidecar found no early-surface exports safe to skip
- subagent review found actor-state nullish precedence and relative `.git`
  resolution drift; both patched with regression tests before commit

Open gaps:
- Full topology scanning, statusline enrichment, daemon HTTP route wiring, and
  online-count network caching remain for later daemon/runtime slices.
- Exact `localeCompare` ordering and config-file-backed session prefix loading
  remain open for the full scanner port.

## 2026-09-08 Multiplexer Sufficiency Audit

Status: complete for this lane
Scope: nine multiplexer modules owned by this stream before TypeScript deletion.

Verification:
- `cargo test --manifest-path native/Cargo.toml -p aimux --test fixture_dashboard_interaction_helpers`
- `cargo test --manifest-path native/Cargo.toml -p aimux --test fixture_dashboard_interaction_overlays`
- `cargo test --manifest-path native/Cargo.toml -p aimux --test fixture_session_launch_default_scribe`
- `cargo test --manifest-path native/Cargo.toml -p aimux --test fixture_multiplexer_runtime_helpers`
- `cargo test --manifest-path native/Cargo.toml -p aimux --test fixture_runtime_guard_repair_start`
- `cargo test --manifest-path native/Cargo.toml -p aimux --test fixture_session_runtime_agent_controls`
- `scripts/audit-fixture-enforcement.mjs` for each touched suite above
- `node scripts/audit-fixture-enforcement.mjs --suite=fixture_runtime_guard_repair_start --corpus=testdata/contracts/v1/multiplexer/runtime-guard-repair-start.json`
- `cargo test --manifest-path native/Cargo.toml -p aimux --lib`

Parity evidence:
- `docs/rust-translation/multiplexer-sufficiency-audit-v1.md`
- Added TypeScript-captured fixtures for direct dashboard interaction helpers,
  async overlay gaps, default-scribe skip/claim-timeout paths, launch helper
  edge cases, tmux-backed session controls, and the runtime guard owned-repair
  start/success/failure branch.

Open gaps:
- None for this lane.

## 2026-09-08 Phase 8 Front Door Stabilization

Status: complete for current native head
Scope: installed-binary seams that corpora cannot cover directly: root
dashboard input, root tool dispatch, command-group dispatch, lazy project reads,
restart-current reporting, and saved-session resume/restore entry points.

Verification:
- `cargo test --manifest-path native/Cargo.toml -p aimux --test dashboard_renderer --test dashboard_controller --test root_session_launch --test fixture_cli_top_level_dispatch`
- `cargo test --manifest-path native/Cargo.toml -p aimux --test project_service_lifecycle --test root_session_launch --test fixture_cli_top_level_dispatch`
- `cargo test --manifest-path native/Cargo.toml -p aimux --lib`
- `cargo clippy --manifest-path native/Cargo.toml -p aimux --lib --bin aimux -- -D warnings`
- `scripts/phase8-live-residuals.py --aimux-bin native/target/debug/aimux --skip-build`
- `scripts/phase8-live-residuals.py --prove-fails --aimux-bin native/target/debug/aimux --skip-build`

Parity evidence:
- `docs/rust-translation/front-door-coverage-v1.md`
- `scripts/phase8-live-residuals.py`
- Commits `2f869c2f`, `bdafc972`, `793c0ba6`, `7c5bdb0e`, and `7cc6c7d4`
  cover worktree details, built-in top-level tools, restore mode preservation,
  root restore, and root resume.
- Commits `6377fe3a` and `949551a7` cover dedicated `overseer status`,
  `scribe status`, `loop list`, and `review list` routes, silent-alias
  detection, bare `graveyard`, and stop-vs-kill graveyard lifecycle semantics.
- Commit `09eb330a` covers top-level `aimux shell` from an
  empty private tmux socket, matching the first-run no-server install bug.
- Commit `4b182d57` applies the same tmux bootstrap invariant to agent
  resume/restore before relaunching an offline session window.

Open gaps:
- Live residuals still do not invoke real Claude/Codex/Aider binaries or
  credentials; they intentionally substitute `/bin/sh` for deterministic CI-safe
  process-boundary coverage.

## 2026-09-08 Phase 8 Residual Sweep

Status: complete for current native head
Scope: full live residual proof sweep after real-machine command aliasing and
graveyard defects were fixed.

Verification:
- `cargo test --manifest-path native/Cargo.toml -p aimux --test core_cli --test core_cli_executor --test core_text`
- `cargo test --manifest-path native/Cargo.toml -p aimux --test core_cli --test core_cli_executor --lib`
- `cargo fmt --manifest-path native/Cargo.toml -p aimux --check`
- `cargo build --manifest-path native/Cargo.toml -p aimux --bin aimux`
- `cargo clippy --manifest-path native/Cargo.toml -p aimux --lib --bin aimux -- -D warnings`
- `scripts/phase8-live-residuals.py --prove-fails --aimux-bin native/target/debug/aimux --skip-build`

Parity evidence:
- `6377fe3a` replaces status/list aliases with dedicated native text routes.
- `949551a7` adds bare `graveyard` routing and live stop-vs-kill graveyard
  lifecycle coverage.
- `09eb330a` makes service launch call the same tmux
  session bootstrap used by agent launch.
- `4b182d57` makes offline agent resume/restore call the same tmux session
  bootstrap before creating the replacement window.
- The live residual proof sweep reports 15 intentional mutations as
  `PROVEN-FAILS`, including command unsupported, command silent alias,
  dashboard input dead, dashboard spawn missing session, shell-service missing
  window, top-level agent missing session, lazy read unavailable,
  restart-current zero projects, SSE reorder, process missing endpoint, and
  graveyard stop-adds-entry.
- The old service-bootstrap bug prove-fails when the service ensure call is
  temporarily removed: `aimux shell` fails against an empty private tmux socket
  before any service window is created.

Open gaps:
- Same as above: real Claude/Codex/Aider credentials and host-specific terminal
  emulator behavior remain outside deterministic temp-root residuals.

## 2026-09-09 TUI Behavior Residuals

Status: complete for current native head
Scope: tmux-attached dashboard behavior after renderer parity: entering a
managed session from the dashboard, returning the attached client to the
dashboard, and repainting cleanly across live terminal resizes.

Verification:
- `python3 -m py_compile scripts/phase8-live-residuals.py`
- `CARGO_TARGET_DIR=/tmp/aimux-cargo-target-dashboard-focus cargo build --manifest-path native/Cargo.toml -p aimux --bin aimux`
- `CARGO_TARGET_DIR=/tmp/aimux-cargo-target-dashboard-focus python3 scripts/phase8-live-residuals.py --only dashboard-attach --skip-build --aimux-bin /tmp/aimux-cargo-target-dashboard-focus/debug/aimux`
- `CARGO_TARGET_DIR=/tmp/aimux-cargo-target-dashboard-focus python3 scripts/phase8-live-residuals.py --only dashboard-attach --mutation dashboard-resize-width-overflow --skip-build --aimux-bin /tmp/aimux-cargo-target-dashboard-focus/debug/aimux`
- `CARGO_TARGET_DIR=/tmp/aimux-cargo-target-dashboard-focus python3 scripts/phase8-live-residuals.py --only dashboard-attach --mutation dashboard-attach-focus-target-missing --skip-build --aimux-bin /tmp/aimux-cargo-target-dashboard-focus/debug/aimux`
- `CARGO_TARGET_DIR=/tmp/aimux-cargo-target-dashboard-focus python3 scripts/phase8-live-residuals.py --only dashboard-attach --mutation dashboard-attach-return-missing --skip-build --aimux-bin /tmp/aimux-cargo-target-dashboard-focus/debug/aimux`
- `cargo test --manifest-path native/Cargo.toml -p aimux --lib`
- `cargo clippy --manifest-path native/Cargo.toml -p aimux --lib -- -D warnings`
- `cargo fmt --manifest-path native/Cargo.toml -p aimux --check`
- `git diff --check`

Parity evidence:
- Commit `c32bb0e5` routes dashboard focus/open actions through the controller
  context wrapper so attached tmux clients focus managed session windows and can
  return to the dashboard.
- Commit `cabd9683` makes the live dashboard refresh viewport dimensions from
  terminal/tmux state, bypasses cached tmux size reads, bounds two-pane frames to
  the viewport, and extends the residual suite with a controlled PTY client that
  proves live 80x24, 100x15, and 200x50 resize repaint behavior.
- Mutation checks prove missing focus handoff, missing dashboard return, and
  width overflow are caught by the residual.

Open gaps:
- Host terminal emulator behavior outside tmux remains outside deterministic
  temp-root residuals.
