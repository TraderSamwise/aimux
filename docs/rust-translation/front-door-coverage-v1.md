# Front Door Coverage v1

Status: adopted.

## Finding

Phase 8 had 325 mutation-proven fixture bindings behind the native runtime, but the installed binary front door still shipped broken in multiple ways: bare tool dispatch dropped the positional tool, resolved spawn mapped to an unimplemented executor path, bare dashboard attach misdetected the terminal, and the dashboard could enter alternate screen without painting content.

Those failures were not contradictions in the corpora. They were outside the corpora boundary. The corpora proved function input/output contracts; they did not prove the assembled binary, daemon loopback transport, tmux terminal, or installed command dispatch.

## Rule

Every executable entry point needs at least one contract at its own boundary, even when every function it calls is already proven. For Aimux CLI/runtime work, that means a seam test must drive the real built binary across process boundaries in an isolated temp root and private tmux socket when the behavior depends on command dispatch, daemon/project-service transport, or terminal attachment.

## Current Coverage

`scripts/phase8-live-residuals.py` now covers the front-door seams that caught the failures:

- command resolution from `aimux --help` through real binary execution;
- shell agent spawn end to end without external agent CLIs or credentials;
- top-level generic tool dispatch through the real binary with `aider` backed
  by `/bin/sh`, covering the bare tool path, tool-argument pass-through, spawn
  execution, and foreground target opening;
- native dashboard first paint into a real tmux pane;
- bare `aimux` attach in a real TTY through a private tmux socket;
- cold project-service reads through `ps`, `list`, `worktree list`, `threads`, and `task list`;
- bare `aimux restart --json` including the current checkout before it has been registered by another command.

These tests intentionally avoid exact TUI layout, screenshots, real Claude/Codex invocations, network access, or timing-sensitive multi-agent orchestration.
