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

`scripts/phase8-live-residuals.py` now covers the front-door seams that caught the failures:

- command resolution from `aimux --help` through real binary execution;
- first-run command seams from empty private tmux sockets, so a warm tmux
  server cannot hide bootstrap regressions;
- command-group output alias detection for `overseer status`, `scribe status`,
  `loop list`, and `review list`;
- bare `graveyard` routing plus stop, resurrect, restore, kill, and fork graveyard lifecycle semantics;
- top-level `aimux shell` service creation from an empty private tmux socket;
- shell agent spawn end to end without external agent CLIs or credentials;
- top-level generic tool dispatch through the real binary with `codex`,
  `claude`, and `aider` backed by `/bin/sh`, covering bare tool paths,
  tool-argument pass-through, spawn execution, foreground target opening, exact
  `--resume`, and fresh `--restore`;
- native dashboard first paint into a real tmux pane, plus advertised input
  keys `?`, `n`, `w`, `v`, `Tab`, and `q`;
- bare `aimux` attach in a real TTY through a private tmux socket;
- cold project-service reads through `ps`, `list`, `worktree list`, `threads`, and `task list`;
- bare `aimux restart --json` including the current checkout before it has been registered by another command.

Current proof head: `7f264dc0`. `scripts/phase8-live-residuals.py --only graveyard --prove-fails --aimux-bin native/target/debug/aimux --skip-build` passes the scoped graveyard lifecycle and reports 16 residual mutations as `PROVEN-FAILS`, including command unsupported, command silent alias, dashboard input dead, dashboard spawn missing session, shell-service missing window, top-level agent missing session, lazy read unavailable, restart-current zero projects, SSE reorder, process missing endpoint, graveyard stop missing entry, and graveyard fork missing session. The front-door, dashboard-spawn, top-level agent, lazy-read, restart-current, shell-service, and graveyard residuals now start from empty private tmux sockets instead of warmed servers. The process residual also covers concurrent `serve` startup over stale daemon info and malformed daemon-start locks. Agent resume/restore shares the same tmux session bootstrap invariant.

These tests intentionally avoid exact TUI layout, screenshots, real Claude/Codex invocations, network access, or timing-sensitive multi-agent orchestration.
