# Notification System

aimux notifications are a product-level system, not a chat-screen side effect.
The client settings, daemon records, relay delivery, and mobile push token flow
should all use the same event vocabulary.

## Event Shape

Notification producers should emit normalized events:

```ts
interface NotificationEvent {
  id: string;
  dedupeKey: string;
  category: "agent" | "system";
  kind: string;
  title: string;
  body: string;
  target?: {
    projectPath?: string;
    sessionId?: string;
    serviceId?: string;
  };
  createdAt: string;
}
```

The current app-side implementation derives initial agent events from
`/desktop-state` transitions. The daemon already stores durable notification
records in `src/notifications.ts`; future work should make those records the
canonical source for cross-device delivery.

## Settings Model

App settings persist a global `notifications` object:

- `enabled`: master kill switch.
- `channels.browser`: Browser Notification API on web.
- `channels.push`: native/mobile push delivery.
- `categories.agent`: per-agent-event controls.
- `categories.system`: reserved for relay and project health events.

Agent event controls currently include:

- `needsInput`: agent moved to an on-you state.
- `blocked`: agent reports a blocked state.
- `errors`: agent reports an error state.
- `completed`: agent completed a task.
- `activity`: new non-attention activity.

Defaults are privacy-conservative: notifications are globally off until the user
turns them on.

## Web Delivery

The web app uses the Browser Notification API only when:

- notifications are globally enabled,
- the browser channel is enabled,
- browser permission is already granted by a user gesture,
- the document is not visible,
- the event is a new state transition instead of a repeated poll result.

The app must not request notification permission on load.

## Mobile Push Path

Mobile push requires a backend delivery path and should not be implemented as a
local-only client effect.

Planned flow:

1. Native app requests permission with `expo-notifications`.
2. Native app registers an Expo push token with the relay, scoped to the Clerk
   user and device.
3. Daemon emits canonical notification records over the relay connection.
4. Relay applies user/device policy and sends push notifications through Expo.
5. App opens notification targets by project/session when tapped.

The relay should own remote delivery because mobile devices may be offline or
outside the daemon's local network.
