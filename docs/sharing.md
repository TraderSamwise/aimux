# Sharing

Aimux shared chats let an owner invite another signed-in account to a specific
agent session.

The owner's daemon remains the authority for the session. The receiver does not
need an Aimux install, daemon, CLI, relay, tmux session, or local copy of the
project.

## Product Model

- Sharing is scoped to one owner, one project, and one session.
- The relay stores the share record, invite state, and participants.
- Accepted receivers connect to the owner's relay object for that share.
- Every receiver request is authorized against the share before it reaches the
  owner's daemon.
- Receiver project workflows and shared chats are separate top-level app areas.

Shared chats should not expose the owner's local project path as a primary UI
concept for receivers. Project names and session labels may provide context,
but receiver navigation should be organized around shared conversations.

## Invite Flow

1. The owner invites an email address from an active agent chat.
2. The relay creates an opaque invite token and stores only a hash.
3. The receiver opens the accept link and signs in.
4. The relay verifies that the invite is active, unexpired, and compatible with
   the signed-in account.
5. The relay adds the receiver as an active participant.
6. The app opens the accepted shared chat route.

Invite tokens are bearer credentials. They should expire, be single-use for the
intended recipient, and never be stored in plaintext.

## Receiver Experience

A receiver can:

- list accepted shared chats from the shared top-level app area
- open a shared chat directly from an accept link or from the shared list
- read the session transcript and live agent output
- send messages to the shared session when the share grants chat access
- leave a shared chat

A receiver cannot manage the owner's project. Project administration routes
such as spawn, stop, kill, fork, worktrees, services, Expose, topology, library,
and graveyard are outside the shared receiver surface.

## Message Attribution

In GUI shared chats, human messages are attributed before they enter the agent
input stream. The agent should see shared human messages in the form:

```text
[sam@example.com] Help us make a document.
```

This lets the agent distinguish owner and receiver messages in a shared
conversation. Local TUI and non-GUI input should not be rewritten with shared
user prefixes.

Once a session has active share participants, GUI owner messages should also be
attributed in the shared chat path so the conversation remains coherent for the
agent and for other participants. If every participant is revoked and the
session is no longer shared, the normal non-shared chat behavior may resume.

## Security Invariants

- The app never supplies trusted actor identity.
- Actor identity comes from the relay after Clerk verification and share
  membership checks.
- Receivers cannot route arbitrary daemon or project-service requests.
- Shared routes are constrained to the shared session.
- Emergency relay lockdown blocks shared receiver access too.
- Security notifications for a receiver connecting to a shared chat are owner
  security events, not receiver account security events.
