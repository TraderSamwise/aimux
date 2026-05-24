# Security Notifications

aimux remote access is an account-security surface. Security events are not
ordinary project notifications: they should bypass per-agent notification
settings, reach every already-trusted surface when possible, and provide a
low-friction way to shut remote access down.

## Goals

- Notify the local daemon whenever a remote client connects.
- Detect first-time remote clients.
- Alert the user by email and by push/in-app notification to other clients.
- Require explicit approval before a first-time client becomes trusted.
- Provide an emergency action link that disables remote access if the user did
  not initiate the connection.
- Keep recovery local-first: after emergency lockdown, remote access stays
  blocked until the user performs an explicit CLI recovery action.

## Device Identity

The relay owns device recognition because it sees every remote connection.

Clients send stable device metadata during the WebSocket handshake:

```ts
interface ClientDeviceInfo {
  deviceId: string;
  kind: "web" | "ios" | "android" | "unknown";
  name?: string;
  platform?: string;
  appVersion?: string;
}
```

`deviceId` is the primary identity. It is generated once and persisted by the
client:

- native: SecureStore/keychain
- web: localStorage, with the understanding that browser storage can be cleared

IP address, country, and user-agent are context signals only. They must not be
used as the primary identity because they are unstable and shared by many users.
When persisted, IP addresses should be hashed or truncated. Raw IP-derived
display text may be included in an immediate email/push alert, but should not be
treated as durable account state.

## Relay Records

Per-user Durable Object storage keeps security state:

```ts
interface SecurityDeviceRecord {
  id: string;
  kind: "web" | "ios" | "android" | "daemon" | "unknown";
  name?: string;
  platform?: string;
  appVersion?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  approvedAt?: string;
  blockedAt?: string;
  lastIpHash?: string;
  lastCountry?: string;
  lastUserAgent?: string;
}

interface SecurityState {
  version: 1;
  devices: Record<string, SecurityDeviceRecord>;
  pushTokens: Record<string, SecurityPushTokenRecord>;
  events: SecurityEventRecord[];
  lockdown?: SecurityLockdownRecord;
  revokedBefore?: string;
}
```

Daemon tokens must include issue time and be rejected when their `iat` is older
than `revokedBefore`.

## Connection Policy

Every remote client connection produces a `client_connected` security event.
The relay sends that event to the daemon so the existing local OS notification
path can alert the user.

When a client device is first seen:

1. Store it as pending.
2. Create a `new_client_detected` security event.
3. Notify the daemon.
4. Notify all other connected clients.
5. Send email if configured.
6. Send push notifications to registered push tokens for other approved
   devices if configured.

The production policy should be `enforce`: pending devices may connect far
enough to display an approval-required state, but proxy/API requests are denied
until the device is approved. Development may use `warn` while testing.

## Delivery Channels

Security notification channels:

- daemon-local OS notification: always attempted when the daemon is connected
- WebSocket security event: sent to connected clients
- email: sent through the configured transactional email provider
- push: sent to Expo push tokens registered by other clients

Security delivery is independent of user agent-notification preferences. A user
may disable optional agent alerts without suppressing account-safety alerts.

If email or push provider configuration is absent, the relay should continue to
enforce security state and deliver the remaining channels.

## Emergency Action Links

Alert emails and push payloads may include an emergency link. The link must not
perform destructive action on GET because mailbox scanners and preview services
can fetch URLs.

Recommended flow:

1. `GET /security/action/:userId/:token` renders a confirmation page.
2. `POST /security/action/:userId/:token` performs the action.
3. Tokens are random, stored hashed, single-use, and expire after seven days.

Emergency shutdown action:

- set lockdown active
- set `revokedBefore` to the current time
- close all daemon and client sockets
- clear or mark device approvals stale
- reject future daemon/client WebSocket connections while lockdown is active
- require CLI recovery before remote access can resume

## CLI Recovery

After lockdown, remote access remains disabled until the user performs an
explicit CLI action:

```bash
aimux security unlock
```

`unlock` should run the browser auth flow again and require a verified Clerk
session. The successful unlock clears relay lockdown state and mints a fresh
daemon token. Plain `aimux login` should not mint fresh daemon credentials
while lockdown is active. Native MFA should come from Clerk/passkeys rather
than a custom aimux 2FA implementation.

## Audit Events

The relay should keep a bounded audit log of security events:

- `client_connected`
- `new_client_detected`
- `device_approved`
- `device_blocked`
- `emergency_lockdown`
- `security_unlocked`

Audit records must not store raw daemon tokens, Clerk tokens, or full request
bodies.
