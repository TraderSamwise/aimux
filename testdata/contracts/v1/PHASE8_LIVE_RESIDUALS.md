# Phase 8 Live Residual Suite

Harness: `scripts/phase8-live-residuals.py`

Purpose: cover the behavior corpus mutation cannot structurally prove: live
tmux/PTY timing, project-service SSE ordering under concurrent clients, and
daemon/project-service startup races.

Isolation rule: every check runs under temp `HOME`, temp `AIMUX_HOME`, random
loopback ports, and disposable process state. The tmux check uses a private
`tmux -L <unique>` socket and kills only that private server. The suite must not
restart or kill the user's live Aimux daemon, project services, dashboard, agent
sessions, or tmux server.

Last command run:

```bash
scripts/phase8-live-residuals.py --prove-fails --skip-build
```

Result:

| Suite | Positive Result | Mutation Proof | Failure Mode Proven |
| --- | --- | --- | --- |
| `phase8-live-tmux-smoke` | Pass | `tmux-drop-output` -> `PROVEN-FAILS` | Missing PTY output is detected by the echoed-marker wait. |
| `phase8-sse-stress` | Pass | `sse-reorder` -> `PROVEN-FAILS` | Alert frame ordering/count drift is detected by every SSE client's ordered title list. |
| `phase8-process-race-smoke` | Pass | `process-delete-endpoint` -> `PROVEN-FAILS` | Missing project-service endpoint publication is detected before the health/state check can pass. |

Observed positive run:

- Native binary: `/tmp/aimux-phase8-live-target/debug/aimux`
- Tmux: private socket, one shell-backed pane, two sent markers, ordered capture,
  and resize to `100x30`.
- SSE: one temp project-service, 8 concurrent `/events` clients, 96 `/notify`
  alerts per client, ordered and complete on every client.
- Process race: temp `AIMUX_HOME`, random `AIMUX_DAEMON_PORT`, stale
  `daemon.json`, malformed daemon-start lock, 4 concurrent `aimux serve`
  commands, one running project service, matching daemon/project-service health.
- Cleanup audit: no remaining `/tmp/aimux-phase8-*` or
  `/tmp/aimux-phase8-live-target/debug/aimux` smoke processes after the run.

## What This Catches

`phase8-live-tmux-smoke` catches PTY buffering regressions, `send-keys`
delivery failures, pane output ordering changes, and tmux resize propagation
errors.

It does not catch real user terminal focus behavior, full attach/detach UI
behavior, or sustained high-volume pane output.

`phase8-sse-stress` catches project-service SSE wakeup failures, multi-client
fanout bugs, missing alert frames, duplicated alert frames, and alert ordering
regressions under concurrent clients.

It does not catch non-loopback network failures, browser `EventSource`
differences, or minutes-long idle keepalive behavior.

`phase8-process-race-smoke` catches stale daemon-info cleanup regressions,
malformed daemon-start lock reclamation failures, concurrent daemon ensure
serialization bugs, missing project-service endpoint publication, and
daemon/project-service health-state mismatches.

It does not catch non-loopback deployment issues, SIGKILL-only teardown edges,
or long-running daemon memory/file-descriptor leaks.
