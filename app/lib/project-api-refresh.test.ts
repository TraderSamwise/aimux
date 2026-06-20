import { describe, expect, it, vi } from "vitest";
import { createSerializedProjectApiRefresh } from "./project-api-refresh";

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

describe("createSerializedProjectApiRefresh", () => {
  it("coalesces overlapping refresh requests into one follow-up run", async () => {
    const first = deferred();
    const second = deferred();
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const serializedRefresh = createSerializedProjectApiRefresh(refresh);

    const firstRun = serializedRefresh();
    const overlappedRun = serializedRefresh();
    expect(refresh).toHaveBeenCalledTimes(1);

    first.resolve();
    await flushPromises();
    expect(refresh).toHaveBeenCalledTimes(2);

    second.resolve();
    await Promise.all([firstRun, overlappedRun]);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
