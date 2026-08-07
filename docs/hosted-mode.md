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

A host that wants that boundary drawn can install the optional
[egress sandbox](./egress-sandbox.md), which default-denies the runtime uid's outbound network
access. It is off by default, and its own page argues about when not to use it.

## What an operator can do

Exactly six routes, on sessions explicitly granted to them:

| | |
|---|---|
| `GET /agents/output` | read the session's pane |
| `POST /agents/input` | send it text |
| `POST /agents/prompt-context` | set or clear the context attached to its prompts |
| `POST /agents/interrupt` | interrupt a running turn |
| `POST /attachments` | upload an image to the session |
| `GET /attachments/<id>/content` | read one back |

The context route holds a line of text — what page the person is on, which
record they are editing — and aimux prepends it to every message that session
is sent until it is replaced or cleared. Sending `text: ""` clears it, and it
expires by itself after thirty minutes so a closed tab cannot leave a context
steering the agent.

The route itself is write-only, but do not read that as secrecy: the context is
composed into the prompt, so it lands in the pane and anyone granted
`GET /agents/output` on that session reads it there. Treat a context as visible
to every principal holding the session, and put nothing in one that the pane
should not carry.

Plus one streaming route:

| | |
|---|---|
| `GET /agents/output/stream` | follow the session's pane as Server-Sent Events |

Everything else on the project service — spawn, fork, stop, kill, migrate, worktrees, services,
graveyard, threads, tasks, shell state — is refused, as are all daemon-level routes. `/agents` (the
session list) is refused too: it returns every session in the project, which would leak other
operators' session ids. So is `/events`: it is project-wide rather than per-session, so it would
carry other operators' sessions to whoever subscribed.

### Attachments

Attachments are bound to a session at upload, and every route that can reach one checks that
binding. An operator's grant is a session, so without the binding there would be nothing to check a
claim against — the store was project-scoped while grants are session-scoped.

Three things make this hold:

- `/attachments/<id>/content` is matched by **pattern** rather than by name, because the id is in
  the path. The character class admits no `.`, `/`, `%`, `;` or `?`, so a traversal, an encoded
  slash or a matrix parameter cannot ride inside the id and land on another route. The path has
  already been through `new URL()` by then, so this is the second defence, not the only one.
- The reply is **bytes**, on the one proxied route that is not JSON. `JSON.stringify` on a Buffer
  yields `{"type":"Buffer","data":[…]}` — six times the size and no longer an image. The content
  type comes from a fixed allowlist (png, jpeg, webp, gif) and is never echoed from upstream; SVG
  is excluded deliberately, being a script-execution vector wearing an image's name.
- `POST /agents/input` refuses an `attachmentIds` entry that belongs to another session. This is
  the one that matters most: the agent reads attachments off local disk, so those bytes never cross
  the transport where any of the above could see them.

Uploads get their own body ceiling (`maxAttachmentBytes`) rather than the prompt one, and are
charged against a per-principal **byte** budget as well as the request budget — the grant check runs
after the body has been read, so counting requests alone would let a token with no grants make the
listener buffer a full attachment on every attempt.

`POST /agents/prompt-context` gets its own ceiling too (`maxContextBytes`), for the opposite reason:
it is the one body a client may rewrite on every navigation, so it is the cheapest way to keep the
listener buffering. It is charged against the same byte budget.

### Streaming

The stream is authorized by a **separate gate** from the buffered routes and never appears on their
allowlist. That is not tidiness: the buffered path reads a whole response before replying, and an
SSE body never ends, so a stream reaching it would hang the request forever.

Its limits are its own, because a request that lives for minutes does not fit a per-minute token
bucket — two concurrent streams per principal, a ten-minute lifetime, a two-minute idle timeout and
a cumulative byte budget. It also releases its pre-authentication peer slot once piping starts:
behind a tunnel every request shares one peer address, so long-lived streams holding those slots
would block everyone else's ordinary calls.

Response headers are synthesized rather than forwarded. The project service sets
`access-control-allow-origin: *` on this route, and copying that onto an authenticated
cross-origin surface would be a real hole.

Closing the connection tears down the upstream capture loop; without that the project service goes
on polling `capture-pane` for a client that has gone. A record is written when the stream opens as
well as when it closes, since a stream can outlive the daemon and a close-only record would leave
no trace of one that never closed.

**Revocation reaches a stream already in flight**, within a few seconds. A stream authenticates once,
at open, so without a live re-check `aimux hosted token revoke` would leave the holder reading for
up to the full ten-minute lifetime — and the idle timeout could not help, because the project
service sends a keepalive on every poll. That is the moment revocation most needs to work, so the
grant is re-checked on a timer and the stream ends as `closed:revoked`. A principal store that
cannot be read counts as revoked.

Note that `startLine` is a tmux scrollback offset, not a cursor, and the upstream re-sends the whole
pane whenever it changes — so a client reconnecting after a drop must expect overlap and dedupe.

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
    "rateLimit": { "requestsPerMinute": 60, "maxConcurrent": 4, "bytesPerMinute": 50331648 },
    "maxPromptBytes": 16384,
    "maxResponseBytes": 1048576,
    "maxAttachmentBytes": 14680064,
    "maxContextBytes": 8192,
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
status, byte counts, and the prompt's hash.

Prompt **bodies** live in a separate file, `~/.aimux/hosted/audit-prompts.jsonl`, joined to their
record by `promptRef`. They are kept only when `auditPromptBodies` is true **and the request
succeeded**, and only the first 1024 characters are retained. Three deliberate choices:

- **Separate file**, because rotation is size-driven: sharing one file let anyone who could
  authenticate push every other operator's records out of it with large bodies.
- **Successful requests only**, because a refused request is the cheapest to generate — a token
  with no grants at all gets a 403 on everything, and storing those bodies is the same flood.
- **Truncated**, so one large prompt cannot displace many small ones. The hash covers the whole
  body, so it identifies but cannot verify the retained prefix.

```bash
aimux hosted audit tail -n 50
aimux hosted audit tail --prompts
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

Only `cf-connecting-ip`, `x-forwarded-for` and `true-client-ip` are accepted; anything else is
ignored with a warning rather than refused at startup, because a startup failure skips hosted mode
entirely and would take a running listener down over a field it can ignore. A name your proxy does
**not** set is one the client sets, which would let anyone forge device identity at will and rotate
the value to slip past the per-address throttles.

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

- **Put an authenticating front door in front of the tunnel** — Cloudflare Access with a service
  token, or mTLS. The hostname is public DNS, so without one the whole internet reaches the
  pre-authentication path with a single bearer token as the only gate. The listener's own bounds
  (512 connections, a 30s request timeout, a 3s headers timeout, per-peer limits before
  authentication and per-principal limits after) keep an anonymous flood from exhausting memory;
  they do not keep it from denying service, and behind a tunnel every request shares one peer
  address, so the pre-auth budget is effectively global.
- No CORS headers are set. The daemon's own surface allows any localhost origin, which is fine on
  loopback and a DNS-rebinding hole behind a tunnel.
- `~/.aimux/hosted/` holds principals, devices, the audit log, the outbox and the lockdown marker,
  all 0600 inside a 0700 directory. Back it up like a credential store, because it is one.
- `yarn check:hosted` runs the whole thing end to end against a real daemon, a real listener and a
  real tmux session — proving an operator's command executes in its granted session, and that every
  other route is refused. It is self-contained (its own home, ports, tmux sessions and temp project)
  and skips when tmux is absent. Run it after changing anything in the hosted path.
