# Security

Aimux remote access is an account-security surface. Security events are separate
from ordinary agent notifications and should reach the owner even when optional
agent alerts are disabled.

## Remote Access

Owner remote access is opt-in:

```bash
aimux login
aimux remote enable
```

The app authenticates with Clerk. The local daemon authenticates to the relay
with a relay-minted daemon token stored under `~/.aimux/auth.json`.

Relay access is isolated per owner account. Remote requests are forwarded only
to the connected daemon for that owner.

## Security Notifications

The relay emits security events when remote clients connect, including
first-time client connections. Delivery can include:

- local daemon notifications
- connected web/native clients
- email, when configured
- push notifications, when configured

Security notifications should distinguish:

- the owner connecting with one of their own devices
- a receiver connecting to one of the owner's shared chats

Receiver shared-chat connection notifications are relevant to the owner because
they touch the owner's daemon. They should not be delivered as receiver account
security alerts.

## Emergency Lockdown

Security alert links may offer emergency lockdown. The destructive action must
not happen on `GET`; confirmation should require a `POST`.

Lockdown should:

- close relay sockets
- revoke existing daemon tokens
- block remote and shared access
- require local CLI recovery before remote access resumes

Recovery is local-first:

```bash
aimux security unlock
```

## Hosted Mode

Hosted mode is an advanced, opt-in local listener for service-host deployments
where several bearer-token principals can be pinned to specific sessions.

```bash
aimux hosted status
aimux hosted token create --label "someone@example.com"
aimux hosted grant prn_a1b2c3 --project /srv/project --session assistant
aimux hosted lockdown on
```

Keep the listener on loopback and put a tunnel or reverse proxy in front of it.
There is no TLS on the hosted listener itself.

Hosted mode grants are session-scoped. They do not grant project administration
or broad daemon access.

## Optional Egress Sandbox

`deploy/sandbox/` contains an optional Linux systemd/nftables profile for hosts
that need outbound network egress controls around agent sessions.

Do not install it by reflex. It is useful when a host runs sessions for people
who are not fully trusted, or when work must be constrained to a small set of
destinations. It is usually the wrong tool for a personal development machine
whose agents legitimately need broad access to APIs, package registries, and git
forges.

The sandbox default-denies outbound traffic for the runtime uid and permits
HTTP(S) through an allowlisted proxy. Read `deploy/sandbox/README.md` before
installing it.
