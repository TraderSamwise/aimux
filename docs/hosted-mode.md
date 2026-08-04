# Hosted Mode

## Status

Current

Hosted mode lets several people converse with agent sessions on one machine, each pinned to the
sessions they were granted and nothing else. It is opt-in and off by default; an installation that
never enables it is unaffected.

Design rationale and the threat model live in [hosted-mode-rfc.md](./hosted-mode-rfc.md). Read the
"What hosted mode is not solving" section there before deploying — the short version is that an
operator who can send text to a session is talking to a tool with a shell, so the boundary that
carries weight is the machine and its credentials, not this route allowlist.

## What an operator can do

Exactly three routes, on sessions explicitly granted to them:

| | |
|---|---|
| `GET /agents/output` | read the session's pane |
| `POST /agents/input` | send it text |
| `POST /agents/interrupt` | interrupt a running turn |

Everything else on the project service — spawn, fork, stop, kill, migrate, worktrees, services,
graveyard, threads, tasks, shell state — is refused, as are all daemon-level routes. `/agents` (the
session list) is refused too: it returns every session in the project, which would leak other
operators' session ids.

Streaming (`/agents/output/stream`) and `/events` are not available to operators yet; poll
`/agents/output` instead.

## Enabling it

Hosted config lives in the **global** config only (`~/.aimux/config.json`). Project config is
committed in repos, so a `hosted` block there would let anyone who clones a repo open a listener; it
is stripped on load.

```jsonc
{
  "hosted": {
    "enabled": true,
    "bindAddress": "127.0.0.1",
    "port": 43195,
    "rateLimit": { "requestsPerMinute": 60, "maxConcurrent": 4 },
    "maxPromptBytes": 16384,
    "maxResponseBytes": 1048576,
    "auditPromptBodies": true,
    "webhookUrl": "https://example.com/api/webhooks/aimux",
    "webhookSecretEnv": "AIMUX_HOSTED_WEBHOOK_SECRET",
    "trustedForwardedHeader": "cf-connecting-ip",
    "retentionDays": 30
  }
}
```

Restart the daemon (`aimux restart`) and check it came up:

```bash
aimux hosted status
```

`status` prints the startup verdict, so a configuration the listener refuses is visible here rather
than only in the daemon log.

**Keep `bindAddress` on loopback and put a tunnel in front.** Binding off-loopback with no active
principals is refused outright, and there is no TLS here — termination belongs to the tunnel or
reverse proxy. `cloudflared` and friends run on the box and dial loopback, which gives remote reach
with no inbound port at all.

## Principals and grants

A principal is a bearer token plus the list of sessions it may drive. The token is shown once.

```bash
aimux hosted token create --label "grand:admin:user_2abc"
aimux hosted grant prn_a1b2c3 --project /srv/grand --session assistant
aimux hosted ungrant prn_a1b2c3 --project /srv/grand --session assistant
aimux hosted token list
aimux hosted token revoke prn_a1b2c3
```

`--project` is normalized to the project's registered repo root, so a subdirectory or a worktree
resolves to the same root the daemon checks against. It is then verified against the very list the
daemon resolves service ports through — a project the daemon could never resolve is refused here
rather than stored as a grant that would 403 forever with nothing to show why.

The label is opaque to aimux and appears in every audit record — use whatever identifier the calling
system knows people by.

A grant names a project root **and** a session id, because session ids are unique only within a
project. The proxied service port is resolved back to a root before the grant is checked, so a grant
in one project can never authorize the same session name in another.

## Audit

Every request appends a JSONL record to `~/.aimux/hosted/audit.jsonl`: who, when, which session,
status, byte counts, and the prompt's hash. The prompt text itself is kept only when
`auditPromptBodies` is true — it will contain whatever a person typed about their business, so
decide deliberately.

```bash
aimux hosted audit tail -n 50
aimux hosted audit tail --json
```

This log is the only place operators can be told apart. A single signed-in tool account cannot
distinguish them, so treat it as the record of record. `retentionDays` prunes it, live file included.

## Connection events

When a webhook is configured, aimux posts signed events: a token's first use, a known token from an
unseen device, repeated authentication failures, revocations, grant changes, and lockdown. What a
human sees is the receiving system's decision — aimux reports, it does not notify.

Delivery is `POST` with:

- `x-aimux-timestamp`: unix seconds
- `x-aimux-signature`: `sha256=<hex>` of `HMAC-SHA256(secret, "{timestamp}.{rawBody}")`

Verify against the **raw** body, and reject a timestamp outside your tolerance. The secret comes
from the environment variable named by `webhookSecretEnv`, which must begin with `AIMUX_`; with no
secret set, events are audited but never sent, because they are never sent unsigned.

Events raised by the CLI are spooled to `~/.aimux/hosted/outbox.jsonl` and delivered by whichever
daemon is running — so a revocation performed while the daemon is down still reaches you when it
comes back.

**Device fingerprints need `trustedForwardedHeader` to be worth anything.** Behind a tunnel every
request arrives from loopback, so without it every client looks identical and "new device" fires on
browser updates while missing real ones. The header is honoured only when the immediate peer is
loopback, and the rightmost value is taken because proxies append. Behind Cloudflare, use
`cf-connecting-ip`.

## Lockdown

```bash
aimux hosted lockdown on
aimux hosted lockdown off
```

Every hosted route returns 503 immediately, before authentication, so nothing reaches the principal
store and the refusal reveals nothing about which tokens are real. `/health` deliberately keeps
answering 200 with `lockdown: true` — a closed door is not a dead box, and a tunnel that marks the
origin down would cost you the ability to observe it.

Lockdown does not touch tmux, the loopback surface, or the relay. Operators lose their door; the
owner keeps theirs.

## Operational notes

- The listener is bounded: 64 connections, a 30s request timeout, a 10s headers timeout, per-peer
  limits applied before authentication, and per-principal limits after it.
- No CORS headers are set. The daemon's own surface allows any localhost origin, which is fine on
  loopback and a DNS-rebinding hole behind a tunnel.
- `~/.aimux/hosted/` holds principals, devices, the audit log, the outbox and the lockdown marker,
  all 0600 inside a 0700 directory. Back it up like a credential store, because it is one.
