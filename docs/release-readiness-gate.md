# Aimux Release Readiness Gate

This gate is the release-candidate rehearsal for the API-first, long-lived
sidecar migration. It is narrower than north-star completion: it proves a build
can be installed over a live Aimux and leave normal users with one coherent
system.

## Automated Gate

Run from a clean checkout on the candidate branch:

```bash
yarn release:readiness
```

This runs the normal source verification plus the north-star tracker verifier.
It does not replace runtime rehearsal because the live daemon, project services,
tmux windows, and installed bundle are outside source-only tests.

## Runtime Rehearsal

Run this before promoting a build:

```bash
git status --short
yarn build
AIMUX_RELEASE_VERSION=local-$(git rev-parse --short HEAD) yarn release:asset
ASSET="$(ls -t release/aimux-*.tar.gz | head -n 1)"
scripts/install.sh "$ASSET"
aimux doctor versions
aimux restart
aimux doctor versions
```

Expected result:

- daemon, project services, dashboards, and runtime owners report the same
  installed build;
- existing dashboard windows reload or reconnect without stale-build decision
  dialogs;
- existing agent tmux windows survive unless the runtime contract intentionally
  requires a rebuild;
- repair notices are recorded in the debug log and visible enough to explain
  why repair happened.

## Multi-Project Smoke

Use at least two active projects with existing dashboards and agent windows.
In each project:

1. Open the dashboard.
2. Start or restore one offline agent and verify the row stays in a pending
   state until fresh API state settles.
3. Stop the agent and verify the row does not flicker back to running.
4. Switch through Dashboard, Coordination, Project, Library, Topology, and
   Graveyard without losing the last coherent snapshot during reconnect.
5. Run `aimux doctor versions` after the smoke and confirm no drift remains.

## Release Evidence

Record the PR, before/after status, and evidence in
[north-star-completion-tracker.md](north-star-completion-tracker.md). Do not
mark a north-star area `Done` unless old authority is removed or explicitly
demoted and tests or smoke evidence would catch regression.
