import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerLogsCommand } from "./logs.js";

function commandWithLogs(deps: Parameters<typeof registerLogsCommand>[1]) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerLogsCommand(program, deps);
  return program;
}

describe("logs CLI command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the selected log path", async () => {
    const selectedLogPath = vi.fn(() => "/logs/project");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await commandWithLogs({ selectedLogPath }).parseAsync(["logs", "path", "--project", "/repo"], { from: "user" });

    expect(selectedLogPath).toHaveBeenCalledWith({ project: "/repo" });
    expect(log).toHaveBeenCalledWith("/logs/project");
  });

  it("tails selected log lines", async () => {
    const selectedLogPath = vi.fn(() => "/logs/daemon");
    const parseLineCount = vi.fn(() => 5);
    const readLastLogLines = vi.fn(() => "line one\nline two");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await commandWithLogs({ selectedLogPath, parseLineCount, readLastLogLines }).parseAsync(
      ["logs", "tail", "--daemon", "--lines", "5"],
      { from: "user" },
    );

    expect(selectedLogPath).toHaveBeenCalledWith({ daemon: true, lines: "5" });
    expect(parseLineCount).toHaveBeenCalledWith("5");
    expect(readLastLogLines).toHaveBeenCalledWith("/logs/daemon", 5);
    expect(log).toHaveBeenCalledWith("line one\nline two");
  });

  it("clears the selected log file", async () => {
    const selectedLogPath = vi.fn(() => "/logs/project");
    const clearLogFile = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await commandWithLogs({ selectedLogPath, clearLogFile }).parseAsync(["logs", "clear"], { from: "user" });

    expect(clearLogFile).toHaveBeenCalledWith("/logs/project");
    expect(log).toHaveBeenCalledWith("Cleared /logs/project");
  });

  it("exits when there are no log entries to tail", async () => {
    const selectedLogPath = vi.fn(() => "/logs/missing");
    const parseLineCount = vi.fn(() => 80);
    const readLastLogLines = vi.fn(() => "");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    await expect(
      commandWithLogs({ selectedLogPath, parseLineCount, readLastLogLines }).parseAsync(["logs", "tail"], {
        from: "user",
      }),
    ).rejects.toThrow("exit");

    expect(error).toHaveBeenCalledWith("No log entries at /logs/missing");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
