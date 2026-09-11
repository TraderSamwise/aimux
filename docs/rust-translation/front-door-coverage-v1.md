# Front Door Coverage v1

Status: adopted.

## Finding

Phase 8 had 325 mutation-proven fixture bindings behind the native runtime, but the installed binary front door still shipped broken in multiple ways: bare tool dispatch dropped the positional tool, resolved spawn mapped to an unimplemented executor path, bare dashboard attach misdetected the terminal, and the dashboard could enter alternate screen without painting content.

Real install testing also caught later front-door regressions after those first fixes: `overseer status`, `scribe status`, and `loop list` returned `aimux ps` output verbatim; `review list` returned `task list` output verbatim; bare `graveyard` was rejected even though `graveyard list` worked. Those were successful wrong answers, so the residual suite now treats silent aliasing as a failure class, not only unsupported-command errors.

Another real-machine first-run bug appeared when no tmux server existed: top-level `aimux shell` routed into service creation and tried `new-window` before ensuring the managed project session. Agent spawn already bootstrapped tmux; service spawn now follows the same invariant.

Real install testing then exposed two lifecycle gaps: `stop` left agents offline in `ps` but absent from `graveyard`, making documented recovery unreachable, and `fork <sessionId>` rejected the advertised same-tool fork form unless `--tool` was supplied. `stop` now moves the session into recoverable graveyard; `graveyard resurrect` clears it back to offline; root `--restore <tool>` relaunches it. Same-tool `fork <sessionId>` now infers the source session's tool from topology.

Those failures were not contradictions in the corpora. They were outside the corpora boundary. The corpora proved function input/output contracts; they did not prove the assembled binary, daemon loopback transport, tmux terminal, or installed command dispatch.

## Rule

Every executable entry point needs at least one contract at its own boundary, even when every function it calls is already proven. For Aimux CLI/runtime work, that means a seam test must drive the real built binary across process boundaries in an isolated temp root and private tmux socket when the behavior depends on command dispatch, daemon/project-service transport, or terminal attachment.

## Current Coverage

`scripts/phase8-live-residuals.py` currently gates the front-door seams that still run on current master:

- command resolution from `aimux --help` through real binary execution;
- command-group output alias detection for `overseer status`, `scribe status`,
  `loop list`, and `review list`;
- private tmux socket basics: PTY output buffering, send-keys delivery, pane
  output ordering, and resize propagation.

Current proof head: `a84c1274`. On 2026-09-11, `yarn audit:phase8-live-residuals:tmux --skip-build --aimux-bin /tmp/aimux-cargo-target-codex-8s9so6/debug/aimux` passed in 0.87s, and `yarn audit:phase8-live-residuals:command-resolution --skip-build --aimux-bin /tmp/aimux-cargo-target-codex-8s9so6/debug/aimux` passed in 89.77s. The full residual sweep is not current evidence: `yarn audit:phase8-live-residuals --skip-build --aimux-bin /tmp/aimux-cargo-target-codex-8s9so6/debug/aimux` failed in 29.50s in the dashboard lane waiting for `phase8-dashboard-key-1`.

The historical dashboard, graveyard, top-level agent, shell-service, restart,
SSE, and process residuals remain useful design notes, but they must be repaired
and re-gated before being cited as current parity evidence. These tests
intentionally avoid exact TUI layout, screenshots, real Claude/Codex invocations,
network access, or timing-sensitive multi-agent orchestration.
