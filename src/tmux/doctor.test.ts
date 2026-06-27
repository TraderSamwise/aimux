import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTmuxDoctorReport, renderTmuxDoctorReport } from "./doctor.js";
import { TmuxRuntimeManager, type TmuxExec } from "./runtime-manager.js";

function createDoctorExec(): TmuxExec {
  return (args: string[]) => {
    const joined = args.join(" ");
    if (joined === "-V") return "tmux 3.5a";
    if (joined === "has-session -t aimux-mobile-abc") return "";
    if (joined === "display-message -p #{client_session}") return "aimux-mobile-abc";
    if (joined === "display-message -p #{window_id}") return "@3";
    if (joined === "display-message -p #{window_name}") return "codex";
    if (joined === "show-options -v -t aimux-mobile-abc prefix") return "C-a";
    if (joined === "show-options -v -t aimux-mobile-abc prefix2") return "C-b";
    if (joined === "show-options -v -t aimux-mobile-abc mouse") return "on";
    if (joined === "show-options -v -t aimux-mobile-abc window-size") return "latest";
    if (joined === "show-options -v -t aimux-mobile-abc extended-keys") return "always";
    if (joined === "show-options -v -t aimux-mobile-abc extended-keys-format") return "csi-u";
    if (joined === "show-options -v -t aimux-mobile-abc terminal-features") {
      return "xterm*:clipboard:ccolour:cstyle:focus:title\nxterm*:extkeys\nxterm*:hyperlinks";
    }
    if (joined === "show-options -v -t aimux-mobile-abc status-format[0]") return "#(top)";
    if (joined === "show-options -v -t aimux-mobile-abc status-format[1]") return "#(bottom)";
    if (joined.startsWith("list-windows -t aimux-mobile-abc -F ")) {
      return [
        "@0\t0\tdashboard\t0\t0\t0\t",
        `@3\t3\tcodex\t1\t0\t0\t${JSON.stringify({
          sessionId: "codex-abc123",
          command: "codex",
          args: ["--full-auto"],
          toolConfigKey: "codex",
          worktreePath: "/repo/mobile",
        })}`,
      ].join("\n");
    }
    if (joined === "show-window-options -v -t @3 @aimux-tool") return "codex";
    if (joined === "show-window-options -v -t @3 allow-passthrough") return "on";
    if (joined === "show-window-options -v -t @3 aggressive-resize") return "on";
    throw new Error(`Unhandled tmux call: ${joined}`);
  };
}

describe("tmux doctor", () => {
  it("builds a compatibility report for the active managed session", () => {
    const tmux = new TmuxRuntimeManager(createDoctorExec());
    const report = buildTmuxDoctorReport(tmux, {
      projectRoot: "/repo/mobile",
      env: {
        TERM: "xterm-ghostty",
        TERM_PROGRAM: "ghostty",
        TMUX: "/tmp/tmux-1000/default,123,0",
      } as NodeJS.ProcessEnv,
      sessionName: "aimux-mobile-abc",
    });

    expect(report.managedSession.exists).toBe(true);
    expect(report.managedSession.options.mouse.ok).toBe(true);
    expect(report.managedSession.options["window-size"]?.ok).toBe(true);
    expect(report.managedSession.terminalFeatures["xterm*:hyperlinks"]?.ok).toBe(true);
    expect(report.activeWindow?.tool).toBe("codex");
    expect(report.activeWindow?.options["allow-passthrough"]?.ok).toBe(true);
    expect(report.activeWindow?.options["aggressive-resize"]?.ok).toBe(true);
    expect(report.statusline.scriptExists).toBe(true);
    expect(report.statusline.statuslineJsonExists).toBe(false);
    expect(report.statusline.sessionFormat).toBe("#(top)");
    expect(report.statusline.windowFormat).toBe("#(bottom)");
    expect(report.managedWindows).toEqual([
      {
        windowId: "@3",
        windowIndex: 3,
        windowName: "codex",
        tool: "codex",
        allowPassthrough: "on",
        aggressiveResize: "on",
      },
    ]);
  });

  it("renders a readable report", () => {
    const tmux = new TmuxRuntimeManager(createDoctorExec());
    const report = buildTmuxDoctorReport(tmux, {
      projectRoot: "/repo/mobile",
      env: {
        TERM: "xterm-ghostty",
        TERM_PROGRAM: "ghostty",
        TMUX: "/tmp/tmux-1000/default,123,0",
      } as NodeJS.ProcessEnv,
      sessionName: "aimux-mobile-abc",
    });

    const text = renderTmuxDoctorReport(report);
    expect(text).toContain("Tmux Doctor");
    expect(text).toContain("managed session exists: yes");
    expect(text).toContain("allow-passthrough: on");
    expect(text).toContain("aggressive-resize: on");
    expect(text).toContain("xterm*:hyperlinks: present");
    expect(text).toContain("statusline:");
    expect(text).toContain("status-format[1]: #(bottom)");
  });

  it("canonicalizes symlinked project roots before deriving the managed session", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "aimux-doctor-"));
    const realRoot = join(tmpRoot, "repo");
    const aliasRoot = join(tmpRoot, "repo-link");
    mkdirSync(realRoot);
    symlinkSync(realRoot, aliasRoot, "dir");

    try {
      const expectedSession = new TmuxRuntimeManager(createDoctorExec()).getProjectSession(
        realpathSync(aliasRoot),
      ).sessionName;
      const aliasSession = new TmuxRuntimeManager(createDoctorExec()).getProjectSession(aliasRoot).sessionName;
      const exec: TmuxExec = (args: string[]) => {
        const joined = args.join(" ");
        if (joined === "-V") return "tmux 3.5a";
        if (joined === `has-session -t ${expectedSession}`) return "";
        if (joined === `show-options -v -t ${expectedSession} prefix`) return "C-a";
        if (joined === `show-options -v -t ${expectedSession} prefix2`) return "C-b";
        if (joined === `show-options -v -t ${expectedSession} mouse`) return "on";
        if (joined === `show-options -v -t ${expectedSession} window-size`) return "latest";
        if (joined === `show-options -v -t ${expectedSession} extended-keys`) return "always";
        if (joined === `show-options -v -t ${expectedSession} extended-keys-format`) return "csi-u";
        if (joined === `show-options -v -t ${expectedSession} terminal-features`) {
          return "xterm*:extkeys\nxterm*:hyperlinks";
        }
        if (joined === `show-options -v -t ${expectedSession} status-format[0]`) return "#(top)";
        if (joined === `show-options -v -t ${expectedSession} status-format[1]`) return "#(bottom)";
        if (joined.startsWith(`list-windows -t ${expectedSession} -F `)) return "";
        throw new Error(`Unhandled tmux call: ${joined}`);
      };

      const report = buildTmuxDoctorReport(new TmuxRuntimeManager(exec), {
        projectRoot: aliasRoot,
        env: {} as NodeJS.ProcessEnv,
      });

      expect(aliasSession).not.toBe(expectedSession);
      expect(report.managedSession.sessionName).toBe(expectedSession);
      expect(report.managedSession.exists).toBe(true);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
