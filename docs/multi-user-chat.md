# Multi-User Chat

Aimux multi-user chat lets the owner of a connected CLI/daemon invite another
authenticated aimux app user into one agent chat. The owner's daemon remains the
authority for the session; invited users connect through the relay and receive
only the routes required for the shared chat.

## Goals

- Let an owner invite a guest by email to a specific project agent session.
- Let the guest accept in the web or mobile app after Clerk authentication.
- Prefix all real-user messages with the speaker name when two or more users are
  active in the chat, so the agent can distinguish people.
- Return future messages to normal single-user input when only one real user
  remains active.
- Preserve existing chat history when a chat is upgraded or downgraded.
- Keep sharing authorization at the relay boundary before requests reach the
  owner's daemon.

## Non-Goals For The First MVP

- Shared project administration. Guests cannot spawn, stop, kill, fork, or
  manage worktrees.
- Broad organization/team roles.
- Rewriting historical messages when sharing mode changes.
- Trusting display names or actor IDs sent by the app.

## Ownership Model

The relay already stores one Durable Object per owner Clerk user. A shared chat
is owned by the user whose daemon token connected to that Durable Object. Guests
do not get their own daemon. Instead, a guest client connects to the owner's
Durable Object for a specific share, and that object authorizes every request
against the share membership.

The share record is scoped to one project session:

- `ownerUserId`: Clerk user ID of the CLI/daemon owner.
- `projectRoot`: owner-local project root shown for context only.
- `sessionId`: agent session ID.
- `participants`: owner and accepted guests.
- `invites`: pending, accepted, or revoked invite records. Expired pending
  invites are pruned during sharing-state normalization instead of being
  persisted as `expired`.
- `version`: optimistic state version for UI refreshes and future migrations.

## Invite Flow

1. Owner creates an invite for an email address from an active agent chat.
2. Relay generates an opaque token, stores only a hash, and emails an accept
   link.
3. Guest opens the link and authenticates with Clerk.
4. Relay verifies the invite is active, unexpired, and email-compatible with the
   authenticated user when an email claim is available.
5. Relay adds the guest as an active participant.
6. Guest app connects to `/client/connect?ownerUserId=...&shareId=...`.

Invite tokens are bearer credentials. They should expire, be single-accept for
the invited email, and never be stored in plaintext.

## Relay Authorization

Owner clients can access their own relay as before. Guest clients are restricted
to the shared session routes:

- `GET /agents/history`
- `GET /agents/output`
- `GET /events`
- attachment routes needed to render or upload chat attachments

Guests must not access daemon-level project management routes or other sessions.
The owner Durable Object injects trusted actor metadata into proxied requests
before forwarding to the daemon.

## Actor Metadata

The app may display a local pending message immediately, but the daemon must
only trust actor metadata injected by the relay. The trusted actor shape is:

```ts
{
  userId: string;
  displayName: string;
  email?: string;
  role: "owner" | "guest";
}
```

Session history records should keep actor metadata so the UI can render speaker
labels without reparsing terminal output.

## Chat Mode

The effective chat mode is derived from active real participants:

- `single`: fewer than two active real users.
- `multi`: two or more active real users.

When mode is `multi`, every real-user input sent to the agent is prefixed:

```text
[Sam]: can you inspect this failure?
[Alex]: I think it is in the relay proxy.
```

When mode returns to `single`, future inputs are sent without prefixes. Existing
history remains unchanged.

## Agent Preamble

When a session first enters multi-user mode, aimux should inject a short preamble
before the next user input:

```text
System note: this chat is now shared by multiple real users. User messages will
be prefixed like [Sam]: ... and [Alex]: ... . Use those names to distinguish who
is speaking.
```

When the session returns to single-user mode, aimux may inject a downgrade note
once. Preamble injection must be idempotent per share/version so reconnects do
not spam the agent.

## Upgrade And Downgrade

Any existing chat can be upgraded by creating a share and accepting at least one
guest. The owner can revoke guests or disable sharing. Mode changes affect
future messages only:

- Upgrade to multi: prefix all future real-user messages.
- Downgrade to single: stop prefixing future messages.
- History and terminal output remain append-only.

## Security Invariants

- The relay never stores plaintext invite tokens.
- A guest cannot route arbitrary requests through the owner's daemon.
- Actor identity is derived from Clerk verification and relay membership, not
  from app-supplied fields.
- Revoked, expired, or consumed invites cannot be accepted again by a different
  user.
- A share cannot outlive owner relay lockdown semantics; emergency lockdown must
  block guest clients too.
