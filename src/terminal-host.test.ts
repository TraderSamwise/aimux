import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalHost } from "./terminal-host.js";

describe("TerminalHost", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not enable terminal focus reporting globally when entering raw mode", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      writes.push(String(chunk));
      return true;
    });

    new TerminalHost().enterRawMode();

    expect(writes.join("")).not.toContain("\x1b[?1004h");
  });

  it("disables terminal focus reporting during restore as defensive cleanup", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      writes.push(String(chunk));
      return true;
    });

    new TerminalHost().restoreTerminalState();

    expect(writes.join("")).toContain("\x1b[?1004l");
  });
});
