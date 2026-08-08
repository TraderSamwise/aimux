import { describe, expect, it } from "vitest";

import { SessionBootstrapService } from "./session-bootstrap.js";

// These read no instance state, so the prototype is a sufficient receiver and
// the service's constructor dependencies stay out of the test.
const bootstrap = SessionBootstrapService.prototype;
const strip = (toolCfg: unknown, args: string[]) =>
  bootstrap.stripToolActionArgs.call(bootstrap, toolCfg as never, args);
const compose = (toolCfg: unknown, action: string[], saved: string[]) =>
  bootstrap.composeToolLaunch.call(bootstrap, toolCfg as never, action, saved);

const CLAUDE = {
  args: ["--dangerously-skip-permissions"],
  resumeArgs: ["--resume", "{sessionId}"],
  resumeFallback: ["--continue"],
  forkArgs: ["--resume", "{sessionId}", "--fork-session"],
};
const CODEX = {
  args: ["--dangerously-bypass-approvals-and-sandbox"],
  resumeArgs: ["resume", "{sessionId}"],
  resumeFallback: ["resume", "--last"],
  forkArgs: ["fork", "{sessionId}"],
};

const UUID = "019ec656-fbab-7cb2-b842-b7831add8c80";

describe("taking a launch verb back out of a session's args", () => {
  /**
   * Every one of these was read off a real runtime-topology.yaml. 19 of 54
   * sessions carried a resume verb they were never supposed to keep.
   */
  it("repairs the shapes actually found on disk", () => {
    expect(strip(CODEX, ["resume"])).toEqual([]);
    expect(strip(CODEX, ["resume", UUID])).toEqual([]);
    expect(strip(CODEX, ["--dangerously-bypass-approvals-and-sandbox", "resume"])).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(strip(CODEX, ["--dangerously-bypass-approvals-and-sandbox", "resume", UUID])).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(strip(CLAUDE, ["--dangerously-skip-permissions", "--resume", UUID])).toEqual([
      "--dangerously-skip-permissions",
    ]);
  });

  it("takes the verb without the id, which is what the oldest rows kept", () => {
    // A two-token pattern against a one-token row matched nothing while this
    // required the whole pattern, and `codex … resume resume <id>` still fails.
    expect(strip(CODEX, ["resume"])).toEqual([]);
    expect(strip(CLAUDE, ["--resume"])).toEqual([]);
    // resumeFallback is not one of the patterns: nothing ever launches with it,
    // so it was never persisted, and aider's is a flag somebody may have chosen.
    expect(strip(CODEX, ["resume", "--last"])).toEqual(["--last"]);
    expect(strip(CLAUDE, ["--continue"])).toEqual(["--continue"]);
    expect(strip({ ...CLAUDE, resumeArgs: undefined, forkArgs: undefined }, ["--continue"])).toEqual(["--continue"]);
  });

  it("leaves everything that is not one of this tool's own verbs", () => {
    expect(strip(CLAUDE, ["--model", "opus", "--verbose"])).toEqual(["--model", "opus", "--verbose"]);
    // codex's verb is a bare word; claude's config must not claim it.
    expect(strip(CLAUDE, ["resume", UUID])).toEqual(["resume", UUID]);
    expect(strip(CODEX, ["--resume", UUID])).toEqual(["--resume", UUID]);
    expect(strip(undefined, ["--resume", UUID])).toEqual(["--resume", UUID]);
  });

  it("keeps a real argument that merely follows a verb", () => {
    // "{sessionId}" stands for an id, never for a flag, so the flag survives.
    expect(strip(CLAUDE, ["--resume", "--model", "opus"])).toEqual(["--model", "opus"]);
  });
});

describe("what gets launched versus what gets remembered", () => {
  it("launches with the verb and remembers without it", () => {
    const { launch, persist } = compose(
      CODEX,
      ["resume", UUID],
      ["--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5.5"],
    );
    expect(launch).toEqual(["--dangerously-bypass-approvals-and-sandbox", "resume", UUID, "--model", "gpt-5.5"]);
    expect(persist).toEqual(["--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5.5"]);
  });

  it("stays put when the same session is launched again and again", () => {
    // The bug: each launch composed the verb onto args that already held one.
    // codex refuses the second positional, so those sessions stopped starting.
    let remembered = ["--dangerously-bypass-approvals-and-sandbox", "resume", UUID];
    for (let launchCount = 0; launchCount < 3; launchCount += 1) {
      const { launch, persist } = compose(CODEX, ["resume", UUID], remembered);
      expect(launch.filter((arg) => arg === "resume")).toHaveLength(1);
      expect(persist).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
      remembered = persist;
    }
  });
});

describe("a placeholder stands for an id, not for anything", () => {
  it("does not let an embedded placeholder swallow the next argument", () => {
    // A user config may write "--resume={sessionId}" as one token. Treating any
    // element merely containing the placeholder as a wildcard made the token
    // AFTER "--model" disappear.
    const embedded = { args: [], resumeArgs: ["--resume={sessionId}"] };
    expect(strip(embedded, ["--model", "opus"])).toEqual(["--model", "opus"]);
  });
});

describe("the rows already on disk", () => {
  /**
   * Read verbatim out of the runtime-topology.yaml files under ~/.aimux: 19 of
   * 54 real sessions had kept a resume verb. codex refuses a second positional,
   * so ten of them could not be started again at all.
   */
  const ON_DISK: Array<[Record<string, unknown>, string[]]> = [
    [CODEX, ["resume"]],
    [CODEX, ["resume", UUID]],
    [CODEX, ["--dangerously-bypass-approvals-and-sandbox", "resume"]],
    [CODEX, ["--dangerously-bypass-approvals-and-sandbox", "resume", UUID]],
    [CLAUDE, ["--dangerously-skip-permissions", "--resume", UUID]],
  ];

  it("each launches with one verb and is remembered with none", () => {
    for (const [toolCfg, saved] of ON_DISK) {
      const action = (toolCfg.resumeArgs as string[]).map((arg) => arg.replace("{sessionId}", "NEW-ID"));
      const { launch, persist } = compose(toolCfg, action, saved);
      const verbs = launch.filter((arg) => arg === "resume" || arg === "--resume");
      expect(verbs, `launch for ${JSON.stringify(saved)}`).toHaveLength(1);
      expect(launch).toContain("NEW-ID");
      expect(persist, `persist for ${JSON.stringify(saved)}`).toEqual(toolCfg.args);
    }
  });

  it("would have caught the bug before the fix", () => {
    // What the old code did: persist whatever it launched with.
    const [toolCfg, saved] = ON_DISK[3];
    const action = (toolCfg.resumeArgs as string[]).map((a) => a.replace("{sessionId}", "NEW-ID"));
    const { launch } = compose(toolCfg, action, saved);
    expect(launch.filter((arg) => arg === "resume")).toHaveLength(1);
    // Persisting the launch line is what produced the doubled verb next time.
    const { launch: relaunched } = compose(toolCfg, action, launch);
    expect(relaunched.filter((arg) => arg === "resume")).toHaveLength(1);
  });
});
