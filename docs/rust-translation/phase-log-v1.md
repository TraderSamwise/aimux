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
