# Runtime Projection Contract

This document records the cut line for metadata, notification context, statusline, and debug projections during the runtime-core hard cut.

## Authority Boundary

- `runtime-topology.yaml` owns agents, services, worktrees, lifecycle, graveyard, bindings, teams, and topology-backed operation state.
- `runtime-exchange.yaml` owns messages, tasks, reviews, handoffs, waits, inbox routing, notification records, and notification read or done state.
- `metadata.json`, `statusline.json`, `notification-context.json`, tmux statusline text files, desktop snapshots, and GUI stores are projections or caches. They may decorate or suppress display for known entities, but they must not mint entities or change lifecycle, ownership, worktree, binding, task, handoff, wait, inbox, or delivery truth.

## Metadata

`metadata.json` is a projection keyed by session id. It may store display context, status text, plan progress, short logs, plugin statusline segments, transcript hints, and derived attention/activity badges.

It must not store or resolve:

- backend session ids
- lifecycle status
- runtime ownership or presence
- authoritative worktree status
- task, handoff, review, wait, inbox, or delivery state

Any generic metadata API write is projection-only unless the route explicitly calls a topology or exchange domain action.

## Statusline

`statusline.json` and tmux statusline text files are generated caches. Statusline readers may use them to render or enrich already-known topology sessions and services. They must not create sessions, services, teammates, worktrees, graveyard rows, or notification/inbox rows.

When statusline cache data disagrees with topology or exchange, topology and exchange win.

## Notifications

Notification records live in `runtime-exchange.yaml` as tagged exchange threads/messages/inbox entries. Notification views are projections over exchange state.

`notification-context.json` records focused client display context for notification suppression only. It must not become delivery state, wait state, inbox state, or attention authority.

## Debug State

Debug state is read-only and labels each source by role:

- authority: topology or exchange state for its domain
- projection/cache: derived display or persistence artifacts
- substrate: live external evidence such as tmux windows or git worktrees
- legacy: old compatibility evidence that must not create truth

Debug matching must not revive hidden fields from projection files. In particular, stale `backendSessionId` fields in `metadata.json` are ignored.
