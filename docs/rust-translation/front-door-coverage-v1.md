# Front Door Coverage v1

Status: adopted.

## Finding

Phase 8 had 325 mutation-proven fixture bindings behind the native runtime, but the installed binary front door still shipped broken in multiple ways: bare tool dispatch dropped the positional tool, resolved spawn mapped to an unimplemented executor path, bare dashboard attach misdetected the terminal, and the dashboard could enter alternate screen without painting content.

Real install testing also caught later front-door regressions after those first fixes: `overseer status`, `scribe status`, and `loop list` returned `aimux ps` output verbatim; `review list` returned `task list` output verbatim; bare `graveyard` was rejected even though `graveyard list` worked. Those were successful wrong answers, so the residual suite now treats silent aliasing as a failure class, not only unsupported-command errors.

Another real-machine first-run bug appeared when no tmux server existed: top-level `aimux shell` routed into service creation and tried `new-window` before ensuring the managed project session. Agent spawn already bootstrapped tmux; service spawn now follows the same invariant.

Real install testing then exposed recoverability gaps where killed agents could be absent from `graveyard`, making documented recovery unreachable. `kill` now moves the session into recoverable graveyard; `graveyard resurrect` clears it back to offline; root `--restore <tool>` relaunches it. `fork <sessionId> --tool <tool>` remains an explicit-tool CLI command, matching the Node CLI contract.

Those failures were not contradictions in the corpora. They were outside the corpora boundary. The corpora proved function input/output contracts; they did not prove the assembled binary, daemon loopback transport, tmux terminal, or installed command dispatch.

## Rule

Every executable entry point needs at least one contract at its own boundary, even when every function it calls is already proven. For Aimux CLI/runtime work, that means a seam test must drive the real built binary across process boundaries in an isolated temp root and private tmux socket when the behavior depends on command dispatch, daemon/project-service transport, or terminal attachment.

## Current Coverage

`scripts/phase8-live-residuals.py` is a blocking CI job for the front-door seams
that still run on current master:

- command resolution from `aimux --help` through real binary execution;
- command-group output alias detection for `overseer status`, `scribe status`,
  `loop list`, and `review list`;
- private tmux socket basics: PTY output buffering, send-keys delivery, pane
  output ordering, and resize propagation.
- first-run shell agent spawn from an empty private tmux socket;
- bare `graveyard` routing plus fork, kill, resurrect, restore, and graveyard
  lifecycle semantics from an empty private tmux socket;
- project-service SSE fanout and alert frame ordering under multiple loopback
  clients;
- daemon/project-service process startup races, stale daemon info cleanup,
  malformed daemon-start lock reclamation, and endpoint publication.

Current proof: CI run `34586601917` on 2026-09-11 passed the blocking
`Phase 8 live residuals` job in 4m48s. That job built the native binary once
and then ran the tmux, command-resolution, agent-shell, graveyard, SSE, and
process lanes serially against isolated roots and a private tmux server.

These tests intentionally avoid exact TUI layout, screenshots, real
Claude/Codex invocations, network access, or timing-sensitive multi-agent
orchestration.
