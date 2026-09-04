import { describe, expect, it, vi } from "vitest";
import {
  checkNotificationPushGuard,
  NOTIFICATION_PUSH_GLOBAL_LIMIT,
  NOTIFICATION_PUSH_SESSION_LIMIT,
} from "./notification-push-guard";

class MemoryStorage {
  private values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
}

function clock(start = 0) {
  const ref = { now: start };
  return {
    now: () => ref.now,
    advance(ms: number) {
      ref.now += ms;
    },
  };
}

describe("checkNotificationPushGuard", () => {
  it("dedupes repeated notification keys within the rolling TTL", async () => {
    const storage = new MemoryStorage();
    const c = clock();

    await expect(
      checkNotificationPushGuard(storage as unknown as DurableObjectStorage, {
        userId: "user_owner",
        sessionId: "claude-1",
        kind: "needs_input",
        dedupeKey: "needs_input:claude-1",
      }, { now: c.now }),
    ).resolves.toEqual({ allowed: true });

    const duplicate = await checkNotificationPushGuard(
      storage as unknown as DurableObjectStorage,
      {
        userId: "user_owner",
        sessionId: "claude-1",
        kind: "needs_input",
        dedupeKey: "needs_input:claude-1",
      },
      { now: c.now },
    );

    expect(duplicate).toMatchObject({ allowed: false, reason: "dedupe" });
    c.advance(61_000);
    await expect(
      checkNotificationPushGuard(storage as unknown as DurableObjectStorage, {
        userId: "user_owner",
        sessionId: "claude-1",
        kind: "needs_input",
        dedupeKey: "needs_input:claude-1",
      }, { now: c.now }),
    ).resolves.toEqual({ allowed: true });
  });

  it("caps each session to five sends per minute", async () => {
    const storage = new MemoryStorage();
    const c = clock();

    for (let i = 0; i < NOTIFICATION_PUSH_SESSION_LIMIT; i += 1) {
      await expect(
        checkNotificationPushGuard(storage as unknown as DurableObjectStorage, {
          userId: "user_owner",
          sessionId: "claude-1",
          kind: "notification",
          dedupeKey: `notice:${i}`,
        }, { now: c.now }),
      ).resolves.toEqual({ allowed: true });
    }

    const limited = await checkNotificationPushGuard(
      storage as unknown as DurableObjectStorage,
      {
        userId: "user_owner",
        sessionId: "claude-1",
        kind: "notification",
        dedupeKey: "notice:limited",
      },
      { now: c.now },
    );

    expect(limited).toMatchObject({ allowed: false, reason: "session_rate_limited" });
    c.advance(61_000);
    await expect(
      checkNotificationPushGuard(storage as unknown as DurableObjectStorage, {
        userId: "user_owner",
        sessionId: "claude-1",
        kind: "notification",
        dedupeKey: "notice:after-window",
      }, { now: c.now }),
    ).resolves.toEqual({ allowed: true });
  });

  it("caps the whole user to twenty sends per minute across sessions", async () => {
    const storage = new MemoryStorage();
    const c = clock();

    for (let i = 0; i < NOTIFICATION_PUSH_GLOBAL_LIMIT; i += 1) {
      await expect(
        checkNotificationPushGuard(storage as unknown as DurableObjectStorage, {
          userId: "user_owner",
          sessionId: `claude-${i}`,
          kind: "notification",
          dedupeKey: `notice:${i}`,
        }, { now: c.now }),
      ).resolves.toEqual({ allowed: true });
    }

    const limited = await checkNotificationPushGuard(
      storage as unknown as DurableObjectStorage,
      {
        userId: "user_owner",
        sessionId: "claude-overflow",
        kind: "notification",
        dedupeKey: "notice:overflow",
      },
      { now: c.now },
    );

    expect(limited).toMatchObject({ allowed: false, reason: "global_rate_limited" });
  });

  it("persists guard state through new guard calls", async () => {
    const storage = new MemoryStorage();
    const now = vi.fn(() => 10_000);

    await expect(
      checkNotificationPushGuard(storage as unknown as DurableObjectStorage, {
        userId: "user_owner",
        dedupeKey: "same-alert",
      }, { now }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      checkNotificationPushGuard(storage as unknown as DurableObjectStorage, {
        userId: "user_owner",
        dedupeKey: "same-alert",
      }, { now }),
    ).resolves.toMatchObject({ allowed: false, reason: "dedupe" });
  });
});
