import { afterEach, describe, expect, it, vi } from "vitest";
import { startProjectApiRelayPoll } from "./project-api-relay-polling";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("startProjectApiRelayPoll", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for a slow refresh before scheduling the next poll", async () => {
    vi.useFakeTimers();
    const first = deferred();
    const second = deferred();
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const poll = startProjectApiRelayPoll(refresh, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(1);

    first.resolve();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(999);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    poll.stop();
  });
});
