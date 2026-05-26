# Multi-User Session Sharing

Aimux multi-user sharing is currently a read-only session viewing surface. The
owner's daemon remains the authority for the session; invited users connect
through the relay and receive only the routes required to view a shared session.

## Goals

- Let an owner invite a guest by email to a specific project agent session.
- Let the guest accept in the web or mobile app after Clerk authentication.
- Preserve read-only access to output, events, and existing historical message
  records where available.
- Keep sharing authorization at the relay boundary before requests reach the
  owner's daemon.

## Non-Goals For The First MVP

- Shared project administration. Guests cannot spawn, stop, kill, fork, or
  manage worktrees.
- Shared user input or agent chat composition.
- Attachment upload.
- Broad organization/team roles.
- Trusting display names or actor IDs sent by the app.

## Ownership Model

The relay already stores one Durable Object per owner Clerk user. A shared session view
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
to read-only shared session routes, and the owner daemon enforces the same
restriction as defense in depth:

- `GET /agents/output`
- `GET /events`

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

Relay-proxied daemon requests carry this metadata in `x-aimux-*` headers:

- `x-aimux-actor-role`: `owner` or `guest`
- `x-aimux-actor-user-id`: authenticated Clerk user ID
- `x-aimux-actor-display-name`: display name for archived UI only
- `x-aimux-actor-email`: optional authenticated email
- `x-aimux-share-id`: active share ID for shared-session guests
- `x-aimux-share-session-id`: session ID the share is allowed to read

The daemon treats owner or local requests as full-control requests. A guest role
is read-only and may only access the shared session output, event, history, and
history read routes. Shared session output, event, and history routes require
`x-aimux-share-session-id` and reject requests for any other session. Attachment
reads are not exposed to guests until attachment records have a session-bound
authorization check. Presence and device metadata are remote security inputs,
not lifecycle authority.

Session history records may keep actor metadata for archived display. There is
no active shared input writer in the current runtime cut.

## Sharing State

Any existing session can be shared by creating an invite and accepting at least
one guest. The owner can revoke guests or disable sharing. History and terminal
output remain append-only.

## Security Invariants

- The relay never stores plaintext invite tokens.
- A guest cannot route arbitrary requests through the owner's daemon.
- Actor identity is derived from Clerk verification and relay membership, not
  from app-supplied fields.
- Revoked, expired, or consumed invites cannot be accepted again by a different
  user.
- A share cannot outlive owner relay lockdown semantics; emergency lockdown must
  block guest clients too.
