import { describe, expect, it, vi } from "vitest";
import { TmuxRuntimeManager } from "./runtime-manager.js";
import { isInTmuxQueryMemoScope, memoizedTmuxQuery, resetTmuxQueryMemo, withTmuxQueryMemo } from "./query-memo.js";

describe("tmux query memo", () => {
  it("is inert outside a scope, so nothing changes for callers that never opt in", () => {
    const compute = vi.fn(() => "x");
    memoizedTmuxQuery("k", compute);
    memoizedTmuxQuery("k", compute);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(isInTmuxQueryMemoScope()).toBe(false);
  });

  it("answers a repeated question once inside one scope", () => {
    const compute = vi.fn(() => "windows");
    const result = withTmuxQueryMemo(() => [
      memoizedTmuxQuery("list-windows", compute),
      memoizedTmuxQuery("list-windows", compute),
      memoizedTmuxQuery("list-windows", compute),
    ]);
    expect(result).toEqual(["windows", "windows", "windows"]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("keys separately, so two questions do not share an answer", () => {
    const windows = vi.fn(() => "w");
    const sessions = vi.fn(() => "s");
    withTmuxQueryMemo(() => {
      memoizedTmuxQuery("list-windows", windows);
      memoizedTmuxQuery("list-sessions", sessions);
    });
    expect(windows).toHaveBeenCalledTimes(1);
    expect(sessions).toHaveBeenCalledTimes(1);
  });

  it("does not leak past the scope", () => {
    const compute = vi.fn(() => "x");
    withTmuxQueryMemo(() => memoizedTmuxQuery("k", compute));
    withTmuxQueryMemo(() => memoizedTmuxQuery("k", compute));
    expect(compute).toHaveBeenCalledTimes(2);
    expect(isInTmuxQueryMemoScope()).toBe(false);
  });

  it("clears even when the scope throws", () => {
    expect(() =>
      withTmuxQueryMemo(() => {
        throw new Error("snapshot failed");
      }),
    ).toThrow("snapshot failed");
    expect(isInTmuxQueryMemoScope()).toBe(false);
  });

  it("inherits an outer scope rather than nesting a fresh one", () => {
    // A memoized helper calling another one must not silently reset the cache.
    const compute = vi.fn(() => "x");
    withTmuxQueryMemo(() => {
      memoizedTmuxQuery("k", compute);
      withTmuxQueryMemo(() => memoizedTmuxQuery("k", compute));
      expect(isInTmuxQueryMemoScope()).toBe(true);
    });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(isInTmuxQueryMemoScope()).toBe(false);
  });

  it("memoizes a failure, since re-running it costs another fork to learn the same thing", () => {
    const compute = vi.fn(() => {
      throw new Error("no server");
    });
    withTmuxQueryMemo(() => {
      expect(() => memoizedTmuxQuery("k", compute)).toThrow("no server");
      expect(() => memoizedTmuxQuery("k", compute)).toThrow("no server");
    });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("re-asks after a reset, for a read that follows a write in the same build", () => {
    const compute = vi.fn(() => "x");
    withTmuxQueryMemo(() => {
      memoizedTmuxQuery("k", compute);
      resetTmuxQueryMemo();
      memoizedTmuxQuery("k", compute);
    });
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

describe("read-only verb memoization at the exec boundary", () => {
  const managerWith = (log: string[][]) =>
    new TmuxRuntimeManager((args) => {
      log.push([...args]);
      return "ok";
    });

  it("asks tmux once for a repeated read inside a scope", () => {
    const log: string[][] = [];
    const tmux = managerWith(log);
    withTmuxQueryMemo(() => {
      tmux.hasSession("s");
      tmux.hasSession("s");
      tmux.hasSession("s");
    });
    expect(log.filter((args) => args[0] === "has-session")).toHaveLength(1);
  });

  it("re-reads after a mutation, which is the case a build actually depends on", () => {
    // A desktop-state build renames a window partway through and then re-lists to
    // observe it. Serving the pre-rename answer defeats that read entirely.
    const log: string[][] = [];
    const tmux = managerWith(log);
    withTmuxQueryMemo(() => {
      tmux.hasSession("s");
      tmux.renameWindow("@1", "renamed");
      tmux.hasSession("s");
    });
    expect(log.filter((args) => args[0] === "has-session")).toHaveLength(2);
    expect(log.some((args) => args[0] === "rename-window")).toBe(true);
  });

  it("never memoizes pane contents, the one read that genuinely changes", () => {
    const log: string[][] = [];
    const tmux = managerWith(log);
    const target = { sessionName: "s", windowId: "@1", windowIndex: 0 } as never;
    withTmuxQueryMemo(() => {
      tmux.captureTarget(target);
      tmux.captureTarget(target);
    });
    expect(log.filter((args) => args[0] === "capture-pane")).toHaveLength(2);
  });

  it("is inert with no scope open, so the CLI and TUI are unaffected", () => {
    const log: string[][] = [];
    const tmux = managerWith(log);
    tmux.hasSession("s");
    tmux.hasSession("s");
    expect(log.filter((args) => args[0] === "has-session")).toHaveLength(2);
  });
});
