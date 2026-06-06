import { describe, expect, it } from "vitest";
import type { AgentOutputBlockType } from "./agent-output-parser.js";
import { parseAgentOutput } from "./agent-output-parser.js";

type Tool = "claude" | "codex";

interface Fragment {
  lines: string[];
  prompts?: string[];
  responses?: string[];
  statuses?: string[];
  metas?: string[];
  forbiddenPrompts?: string[];
}

const rngForSeed = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <T>(rng: () => number, values: T[]) => values[Math.floor(rng() * values.length)] as T;

const maybeBlank = (rng: () => number) => (rng() > 0.45 ? [""] : []);

const divider = () =>
  "────────────────────────────────────────────────────────────────────────────────────────────────";

const footer = (tool: Tool, seed: number) =>
  tool === "codex"
    ? [`  gpt-5.5 medium · ~/workspace/project/.aimux/worktrees/fuzz-${seed}`]
    : [
        `  user@host ~/workspace/project fuzz-${seed} ██░░░░5% Opus 4.8`,
        "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
      ];

const startupChrome = (tool: Tool, seed: number): Fragment =>
  tool === "codex"
    ? {
        lines: [
          "╭─────────────────────────────────────────╮",
          "│ >_ OpenAI Codex (v0.136.0)              │",
          "│                                         │",
          "│ model:       loading   /model to change │",
          `│ directory:   ~/workspace/project/fuzz-${seed} │`,
          "│ permissions: YOLO mode                  │",
          "╰─────────────────────────────────────────╯",
          ...(seed % 2 === 0 ? [""] : []),
        ],
      }
    : {
        lines: [`claude · ~/workspace/project/fuzz-${seed}`, "Opus 4.8 (1M context)", ""],
      };

const actualTurn = (tool: Tool, seed: number, rng: () => number): Fragment => {
  const prompt = `USER_SENTINEL_${tool}_${seed}`;
  const response = `RESPONSE_SENTINEL_${tool}_${seed}`;
  if (tool === "codex") {
    return {
      lines: [
        `› ${prompt} do the requested work`,
        ...maybeBlank(rng),
        `• ${response} completed the work.`,
        "  The answer includes a literal prompt marker > without becoming a prompt.",
      ],
      prompts: [prompt],
      responses: [response],
    };
  }
  return {
    lines: [
      `❯ ${prompt} do the requested work`,
      ...maybeBlank(rng),
      `⏺ ${response} completed the work.`,
      "  The answer mentions /mcp and keeps wrapped assistant text together.",
    ],
    prompts: [prompt],
    responses: [response],
  };
};

const activeInput = (tool: Tool, seed: number, rng: () => number): Fragment => {
  const suggestion = `SUGGESTION_SENTINEL_${tool}_${seed}`;
  if (tool === "codex") {
    return {
      lines: [`› ${suggestion} Implement {feature}`, ...maybeBlank(rng), ...footer(tool, seed)],
      statuses: [suggestion],
      forbiddenPrompts: [suggestion],
    };
  }
  return {
    lines: [divider(), `❯ ${suggestion} no that's fine, what's next?`, divider(), ...footer(tool, seed)],
    statuses: [suggestion],
    forbiddenPrompts: [suggestion],
  };
};

const activityRow = (tool: Tool, seed: number, rng: () => number): Fragment => {
  const status = `STATUS_SENTINEL_${tool}_${seed}`;
  const variants = [
    `* Cooked for 1m 2s · ${status} · 1 shell still running`,
    `* Carbonated for 42s · ${status}`,
    `* Indexing… (${status} · running stop hook · 11s · ↓ 16 tokens)`,
    `- Worked for 20m 16s · ${status}`,
    `• Sautéed for 5s · ${status}`,
    `✻ Baked for 3s · ${status}`,
  ];
  return {
    lines: [pick(rng, variants)],
    statuses: [status],
  };
};

const assistantActivityMention = (tool: Tool, seed: number, rng: () => number): Fragment => {
  const response = `ACTIVITY_MENTION_RESPONSE_SENTINEL_${tool}_${seed}`;
  const marker = tool === "codex" ? "•" : "⏺";
  const variants = [
    `mentions a leaked activity row: Carbonated for 42s while explaining the bug.`,
    `says Worked for 20m 16s was visible in the transcript, but this is prose.`,
    `describes Indexing… (running stop hook · 11s) as text the parser should not overmatch.`,
  ];
  return {
    lines: [`${marker} ${response} ${pick(rng, variants)}`],
    responses: [response],
  };
};

const toolActionRow = (tool: Tool, seed: number, rng: () => number): Fragment => {
  const status = `ACTION_SENTINEL_${tool}_${seed}`;
  const variants =
    tool === "claude"
      ? [
          `⏺ Bash(echo ${status})`,
          `⏺ Read 2 files (ctrl+o to expand) ${status}`,
          `⏺ Update(src/${status}.ts)`,
          `⏺ Background command "Wait for ${status}" completed (exit code 0)`,
        ]
      : [
          `• Ran git status --short ${status}`,
          `• Ran yarn test ${status}`,
          `• Bash(git diff --stat ${status})`,
        ];
  return {
    lines: [pick(rng, variants)],
    statuses: [status],
  };
};

const wrappedClaudeToolActionRow = (tool: Tool, seed: number): Fragment => {
  const status = `WRAPPED_ACTION_SENTINEL_${tool}_${seed}`;
  return {
    lines: [
      `⏺ Bash(cd /workspace/project/${status}`,
      "  git status…)",
      "  ⎿  Running in the background (down arrow to manage)",
    ],
    statuses: [status],
  };
};

const feedbackSurvey = (tool: Tool, seed: number): Fragment => {
  const status = `SURVEY_SENTINEL_${tool}_${seed}`;
  return {
    lines: [
      `• How is Claude doing this session? (optional) ${status}`,
      "  1: Bad     2: Fine    3: Good    0: Dismiss",
      divider(),
      `❯ ${status} visible survey input`,
      divider(),
      ...footer("claude", seed),
    ],
    statuses: [status],
    forbiddenPrompts: [status],
  };
};

const assistantMarkdown = (tool: Tool, seed: number): Fragment => {
  const response = `MARKDOWN_RESPONSE_SENTINEL_${tool}_${seed}`;
  const marker = tool === "codex" ? "•" : "⏺";
  return {
    lines: [
      `${marker} ${response} includes markdown-looking content.`,
      '  """',
      "  MESSAGE CONTENT INTENT is enabled + saved",
      '  """',
      "  * Added tests (2 files)",
    ],
    responses: [response],
  };
};

const assistantToolMention = (tool: Tool, seed: number, rng: () => number): Fragment => {
  const response = `TOOL_MENTION_RESPONSE_SENTINEL_${tool}_${seed}`;
  const marker = tool === "codex" ? "•" : "⏺";
  const variants = [
    "mentions Claude Code and OpenAI Codex as plain assistant text.",
    "compares OpenAI Codex with Claude Code without changing parser mode.",
    "says Claude Code can coexist with OpenAI Codex in prose.",
  ];
  return {
    lines: [`${marker} ${response} ${pick(rng, variants)}`],
    responses: [response],
  };
};

const mcpStartup = (tool: Tool, seed: number): Fragment => {
  const status = `MCP_STATUS_SENTINEL_${tool}_${seed}`;
  return {
    lines: [`• Starting MCP servers (1/4): ${status}, chrome-devtools (0s • esc to interrupt)`],
    statuses: [status],
  };
};

const codexResumePickerSelection = (seed: number): Fragment => {
  const response = `PICKER_RESPONSE_SENTINEL_codex_${seed}`;
  const status = `PICKER_STATUS_SENTINEL_codex_${seed}`;
  return {
    lines: [
      `Resume a previous session ${response}`,
      " Type to search                                                       Filter:  Cwd [All]   Sort: [Updated] Created",
      `  ❯ now         Saved as ~/cs/hyperprop/HANDOFF.md. ${status} Here it is:  ---  What: Decentralized eval prop firm on...`,
      "    1m ago      previous agent was in a compact loop.TL;DR: we were trying to fix the iOS chat composer bein...",
      "    15h ago     reply exactly CODEX_PROTOCOL_OK",
    ],
    responses: [response],
    statuses: [status],
    forbiddenPrompts: [status, "previous agent was in a compact loop", "CODEX_PROTOCOL_OK"],
  };
};

const codexWorkingDirectoryPicker = (seed: number): Fragment => {
  const response = `CWD_PICKER_RESPONSE_SENTINEL_codex_${seed}`;
  const status = `CWD_PICKER_STATUS_SENTINEL_codex_${seed}`;
  const meta = `CWD_PICKER_META_SENTINEL_codex_${seed}`;
  return {
    lines: [
      `Choose working directory to resume this session ${response}`,
      "  Session = latest cwd recorded in the resumed session",
      "  Current = your current working directory",
      "  1. Use session directory (/Users/sam/cs/aimux)",
      `› 2. Use current directory (/Users/sam/cs/aimux/.aimux/worktrees/chat-parser) ${status}`,
      "  Press enter to continue",
      "│ >_ OpenAI Codex (v0.136.0)                           │",
      "│                                                      │",
      `│ model:       gpt-5.5 high   /model to change         │ ${meta}`,
      "│ directory:   ~/cs/aimux/.aimux/worktrees/chat-parser │",
      "│ permissions: YOLO mode                               │",
    ],
    responses: [response],
    statuses: [status],
    metas: [meta],
    forbiddenPrompts: [status],
  };
};

const codexCommandOutputTree = (seed: number): Fragment => {
  const status = `TREE_STATUS_SENTINEL_codex_${seed}`;
  const response = `TREE_RESPONSE_SENTINEL_codex_${seed}`;
  return {
    lines: [
      `• Ran aimux daemon project-ensure --project /Users/sam/cs/hyperprop --json ${status}`,
      "  └ {",
      '      "project": {',
      "    … +5 lines (ctrl + t to view transcript)",
      "      }",
      "    }",
      "",
      `• ${response} prod ensure completed.`,
    ],
    responses: [response],
    statuses: [status],
  };
};

const codexTrailingSuggestionAfterStatus = (seed: number): Fragment => {
  const response = `TRAILING_RESPONSE_SENTINEL_codex_${seed}`;
  const status = `TRAILING_STATUS_SENTINEL_codex_${seed}`;
  return {
    lines: [
      `• ${response} worktree looks clean and usable.`,
      "",
      `• Ran git branch -vv && git rev-parse --abbrev-ref --symbolic-full-name @{u} ${status}`,
      "  └ ## chat-parser",
      "",
      "› Explain this codebase",
      "",
      "  gpt-5.5 high · ~/workspace/project",
    ],
    responses: [response],
    statuses: [status, "Explain this codebase"],
    forbiddenPrompts: ["Explain this codebase"],
  };
};

const codexResultSummaryAfterMetadata = (seed: number): Fragment => {
  const meta = `RESULT_META_SENTINEL_codex_${seed}`;
  const response = `RESULT_RESPONSE_SENTINEL_codex_${seed}`;
  const prompt = `RESULT_PROMPT_SENTINEL_codex_${seed}`;
  const status = `RESULT_STATUS_SENTINEL_codex_${seed}`;
  return {
    lines: [
      `~/.aimux/projects.json.backup-2026-06-06T06-44-29-597Z ${meta}`,
      "  Result:",
      `  - Registry: 23087 -> 6 ${response}`,
      "  - Live /projects: now ~0.24-0.51s",
      "  - Remaining projects: aimux, hyperprop, premys",
      "",
      `› ${prompt} Open a PR. run review-coderabbit until green. then merge and cut new branch.`,
      `■ Conversation interrupted - tell the model what to do differently. ${status}`,
    ],
    metas: [meta],
    responses: [response],
    prompts: [prompt],
    statuses: [status],
  };
};

const fragmentMakersForTool = (tool: Tool) =>
  tool === "claude"
    ? ([
        activeInput,
        activityRow,
        assistantActivityMention,
        toolActionRow,
        wrappedClaudeToolActionRow,
        feedbackSurvey,
        assistantMarkdown,
        assistantToolMention,
        mcpStartup,
      ] as const)
    : ([
        activeInput,
        activityRow,
        assistantActivityMention,
        toolActionRow,
        assistantMarkdown,
        assistantToolMention,
        mcpStartup,
      ] as const);

const collectByType = (raw: string, tool: Tool) => {
  const parsed = parseAgentOutput(raw, { tool });
  const grouped = new Map<AgentOutputBlockType, string>();
  for (const block of parsed.blocks) {
    grouped.set(block.type, `${grouped.get(block.type) ?? ""}\n${block.text}`);
  }
  return { parsed, grouped };
};

const assertFragmentSentinels = (
  fragments: Fragment[],
  grouped: Map<AgentOutputBlockType, string>,
  context: string,
) => {
  for (const prompt of fragments.flatMap((fragment) => fragment.prompts ?? [])) {
    expect(grouped.get("prompt") ?? "", `${context} prompt ${prompt}`).toContain(prompt);
  }
  for (const response of fragments.flatMap((fragment) => fragment.responses ?? [])) {
    expect(grouped.get("response") ?? "", `${context} response ${response}`).toContain(response);
  }
  for (const status of fragments.flatMap((fragment) => fragment.statuses ?? [])) {
    expect(grouped.get("status") ?? "", `${context} status ${status}`).toContain(status);
  }
  for (const meta of fragments.flatMap((fragment) => fragment.metas ?? [])) {
    expect(grouped.get("meta") ?? "", `${context} meta ${meta}`).toContain(meta);
  }
  for (const forbidden of fragments.flatMap((fragment) => fragment.forbiddenPrompts ?? [])) {
    expect(grouped.get("prompt") ?? "", `${context} forbidden prompt ${forbidden}`).not.toContain(forbidden);
  }
};

describe("parseAgentOutput deterministic fuzz", () => {
  for (const tool of ["claude", "codex"] as const) {
    for (let seed = 1; seed <= 80; seed += 1) {
      it(`keeps ${tool} transcript sentinels stable under generated variant ${seed}`, () => {
        const rng = rngForSeed(seed * (tool === "claude" ? 17 : 31));
        const fragments: Fragment[] = [startupChrome(tool, seed), actualTurn(tool, seed * 100, rng)];
        const fragmentCount = 4 + Math.floor(rng() * 8);
        const fragmentMakers = fragmentMakersForTool(tool);

        for (let i = 0; i < fragmentCount; i += 1) {
          const maker = pick(rng, fragmentMakers);
          fragments.push(maker(tool, seed * 100 + i + 1, rng));
          if (rng() > 0.65) fragments.push({ lines: maybeBlank(rng) });
        }

        fragments.push(activeInput(tool, seed * 1000, rng));
        fragments.push({ lines: footer(tool, seed * 1000) });

        const raw = fragments.flatMap((fragment) => fragment.lines).join("\n");
        const { parsed, grouped } = collectByType(raw, tool);
        const inferred = parseAgentOutput(raw);

        expect(parseAgentOutput(raw, { tool }).blocks).toEqual(parsed.blocks);
        expect(inferred.parser.tool, `${tool} seed ${seed} inferred tool`).toBe(tool);
        expect(inferred.blocks, `${tool} seed ${seed} inferred blocks`).toEqual(parsed.blocks);
        expect(parsed.blocks.map((block) => block.type)).not.toContain("raw");

        assertFragmentSentinels(fragments, grouped, `${tool} seed ${seed}`);
      });
    }
  }

  const minedCodexFragments = [
    codexResumePickerSelection,
    codexWorkingDirectoryPicker,
    codexCommandOutputTree,
    codexTrailingSuggestionAfterStatus,
    codexResultSummaryAfterMetadata,
  ];

  for (let seed = 1; seed <= 50; seed += 1) {
    it(`keeps mined Codex live edge case ${seed} stable`, () => {
      const rng = rngForSeed(seed * 67);
      const mined = pick(rng, minedCodexFragments)(seed);
      const fragments: Fragment[] = [{ lines: maybeBlank(rng) }, mined, { lines: maybeBlank(rng) }];

      const raw = fragments.flatMap((fragment) => fragment.lines).join("\n");
      const { parsed, grouped } = collectByType(raw, "codex");

      expect(parseAgentOutput(raw, { tool: "codex" }).blocks).toEqual(parsed.blocks);
      expect(parsed.blocks.map((block) => block.type), `mined Codex seed ${seed} no raw`).not.toContain("raw");
      assertFragmentSentinels(fragments, grouped, `mined Codex seed ${seed}`);
    });
  }

  for (let seed = 1; seed <= 40; seed += 1) {
    it(`does not infer parser mode from casual tool mentions without chrome ${seed}`, () => {
      const rng = rngForSeed(seed * 47);
      const tool = pick(rng, ["claude", "codex"] as const);
      const fragment = assistantToolMention(tool, seed, rng);
      const raw = fragment.lines.join("\n");
      const parsed = parseAgentOutput(raw);

      expect(parsed.parser.tool).toBe("unknown");
      expect(parsed.blocks.map((block) => block.type)).toEqual(["response"]);
      expect(parsed.blocks[0]?.text).toContain(fragment.responses?.[0]);
    });
  }
});
