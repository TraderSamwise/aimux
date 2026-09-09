# Phase 8 Complete

Audit point: final Phase 8 cut tree after `d1812def` and subsequent native cleanup commits. The definitive post-cut enforcement audit completed on this tree and rewrote `testdata/contracts/v1/ENFORCEMENT_AUDIT.md` at Sep 8 08:47:19 2026, after `594165ad`.

## Cut Commits

| Commit | Purpose | File/line count |
| --- | --- | --- |
| `a9220736` | Delete retired source graph | 527 files changed, 192,206 deletions |
| `f8c0d3cd` | Delete TypeScript capture harness | 276 files changed, 68,306 deletions |
| `594165ad` | Switch release and test tooling to native | 7 files changed, 15 insertions, 202 deletions |
| `d1812def` | Record post-cut readiness | 1 file changed, 13 insertions, 10 deletions |

The two deletion commits removed 803 files and 260,512 lines from this worktree.

## Final Parity Numbers

These are the measured results from the definitive post-cut audit on this tree.

| Metric | Value |
| --- | ---: |
| Behavior corpora | 319 |
| Fixture suite/corpus bindings | 325 |
| Mutation-proven cases | 4,048 |
| `PROVEN-FAILS` bindings | 325 |
| `VACUOUS` bindings | 0 |
| `CHECKLIST` bindings | 0 |
| `ERROR` bindings | 0 |
| `STATIC` bindings | 0 |

The definitive post-cut audit command was:

```bash
node scripts/audit-fixture-enforcement.mjs --write-report
```

That script uses only Node built-ins and the committed Rust fixture suites plus JSON corpora. It does not require the deleted TypeScript source or Vitest harness.

## What Survives

The eight app-required TypeScript contract/helper files remain because `app/` is outside the Phase 8 deletion scope and still imports them:

- `src/agent-events-contract.ts`
- `src/agent-transcript-contract.ts`
- `src/attachment-text.ts`
- `src/core-command-contract.ts`
- `src/expose-preview-crop.ts`
- `src/project-api-contract.ts`
- `src/relay-contract.ts`
- `src/worktree-colors.ts`

Other surviving pieces:

- `app/`: the Expo client remains TypeScript and was never part of the normal CLI, daemon, project-service, tmux runtime, or dashboard hot path deletion.
- `scripts/audit-fixture-enforcement.mjs`: survives so the committed corpora can keep proving Rust parity after the TypeScript source is gone.
- `scripts/phase8-live-residuals.py`: survives because corpus mutation cannot prove live PTY timing, SSE ordering under load, or process race behavior.
- Committed JSON corpora under `testdata/contracts/v1/`: survive as historical TypeScript output and Rust parity specifications.
- Contract data files still under `src/`: survive as data consumed by app/Rust tests, not as retired executable hot-path TypeScript.

## What No Longer Can Be Done

The TypeScript capture harness is gone on this branch. The corpora are historical artifacts captured before deletion and cannot be regenerated here without restoring the deleted TypeScript graph and capture scripts.

To re-verify the committed corpora against Rust, run:

```bash
node scripts/audit-fixture-enforcement.mjs --write-report
```

To regenerate any corpus from TypeScript, use a pre-cut checkout or a temporary worktree at the pre-deletion state, such as `1a8eff64`, with the TypeScript source, Vitest config, and `scripts/capture-*.mjs` files present. Recreating capture on this branch would require restoring at least `a9220736` and `f8c0d3cd`, plus any later build-tool removals that prevent Vitest or the capture scripts from running.

## Known Gaps Carried Forward

- PTY recording writer behavior was already dead before Phase 8; see `8c019c0c`, which documents that the writer had no production call path before the cut.
- Live tmux attach/detach, focus, pane resize, PTY buffering, and terminal input timing remain only partially reducible to fixture data.
- SSE route shape and event IDs are fixture-covered, but load behavior, reconnect races, backpressure, and concurrent client ordering remain live-only risks.
- Daemon/project-service PID, lock, port, and stale-manifest races remain OS-scheduling-dependent despite fixture and smoke coverage.
- External Claude/Codex hook payload parsing is covered, but real external-tool invocation order, inherited shell environment, and settings-file write races remain live-only risks.
- Platform integrations remain environment-dependent: desktop notification delivery, browser opening, `python3` use in `tmux-open-hyperlink.sh`, macOS notifier packaging, and Linux `xdg-open` behavior.
- Arbitrary user JS plugin execution is intentionally suspended for Phase 8. The two built-in plugins are native; existing user `~/.aimux/plugins/*.js` execution is not preserved.
- Native plugin event subscription is represented in the serializable API, but real lifecycle/activity/attention event dispatch into plugins is not yet stress-tested under load.

The live residual suite covers the smallest current slice of those live-only risks: tmux/PTY timing, SSE ordering under load, and daemon/project-service process races. It does not replace manual/platform verification for every OS integration above.

## Bugs Found By The Apparatus

The fixture and mutation system found 772-plus real parity bugs before the cut. The parser was the clearest example: 133 of 140 adversarial parser cases and 410 of 410 parser fuzz cases failed before the Rust implementation was corrected. Those failures were not caught by the earlier hand-transcribed Rust tests.
