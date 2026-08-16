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

Owner device trust has two independent gates:

- `SECURITY_DEVICE_POLICY=enforce` blocks owner client requests until the
  device is approved from the local CLI.
- `SECURITY_DEVICE_PROOF_POLICY=enforce` requires every owner client and owner
  push-token registration to prove possession of that device's private key.

List and manage owner devices from the machine that holds the daemon token:

```bash
aimux security devices
aimux security approve <deviceId>
aimux security block <deviceId>
aimux security unblock <deviceId>
```

Web, iOS, and Android clients store a stable device id plus a P-256 signing key.
The private key stays on the client: SecureStore on native, AsyncStorage on web.
The relay stores only the public key. First proof binding for a legacy approved
device clears inherited approval, so the device must be approved again with the
new key attached.

With both relay policies set to `enforce`, this is a hard cutover: existing
approved legacy devices can connect once to bind their key, then return to
pending until `aimux security approve <deviceId>` is run locally.

Shared-chat guests are not owner devices. Their access is governed by the share
ACL and is intentionally separate from owner device approval/proof policy.

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

Normal agent/project push notifications are filtered by owner device approval
when `SECURITY_DEVICE_POLICY=enforce`. A proof-valid pending device can still
connect far enough to receive security state and approval-related events, but it
cannot proxy daemon requests and should not receive normal agent/project alerts.

Push token registration for owner devices carries the same signed device proof
as the relay WebSocket connection. This prevents a signed-in but untrusted
client from claiming another approved `deviceId` for notifications.

Shared-chat push registration remains governed by share participation. Shared
guests are not owner devices and do not use owner device proof.

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

`unlock` only clears lockdown. It does not approve devices.

## IP Allowlisting And Passkeys

IP allowlisting is best treated as an optional coarse filter, not the primary
trust boundary. Mobile networks, VPNs, and browser egress make default
same-source-IP behavior brittle, and `aimux.app` may legitimately be used away
from the daemon host. Device approval plus signed device proof is the primary
remote-client control.

Passkeys remain useful as a user-presence step for high-risk actions, but they
should sit above the device layer. The current local-only approval path keeps
device mutation authority on the machine with the daemon token.

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
