import { describe, expect, it } from "vitest";

import { buildAgentIdentityErrorPayload, buildAgentIdentityPayload, renderAgentIdentityLines } from "./agent-id.js";

describe("agent id CLI rendering", () => {
  it("builds the JSON payload for a resolved agent identity", () => {
    expect(
      buildAgentIdentityPayload("/repo", {
        ok: true,
        sessionId: "claude-abc123",
        backendSessionId: "native-session",
        source: "topology",
        tool: "claude",
        toolConfigKey: "claude",
        command: "claude",
        status: "graveyard",
        worktreePath: "/repo/.aimux/worktrees/feature",
      }),
    ).toEqual({
      ok: true,
      projectRoot: "/repo",
      canonical: "claude",
      aimuxId: "claude-abc123",
      backendSessionId: "native-session",
      source: "topology",
      status: "graveyard",
      worktreePath: "/repo/.aimux/worktrees/feature",
    });
  });

  it("renders stable human-readable identity lines", () => {
    expect(
      renderAgentIdentityLines({
        ok: true,
        projectRoot: "/repo",
        canonical: "codex",
        aimuxId: "codex-abc123",
        backendSessionId: "native-session",
        source: "discovered",
        status: "offline",
        worktreePath: "/repo",
      }),
    ).toEqual([
      "codex-abc123  canonical=codex  backend=native-session  status=offline  source=discovered",
      "worktree: /repo",
    ]);
  });

  it("builds the JSON payload for a failed identity lookup", () => {
    expect(
      buildAgentIdentityErrorPayload("/repo", {
        ok: false,
        sessionId: "missing",
        reason: 'Agent "missing" is not managed in runtime topology',
      }),
    ).toEqual({
      ok: false,
      projectRoot: "/repo",
      sessionId: "missing",
      error: 'Agent "missing" is not managed in runtime topology',
    });
  });
});
