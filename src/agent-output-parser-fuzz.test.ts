import { describe, expect, it } from "vitest";
import type { AgentOutputBlockType } from "./agent-output-parser.js";
import { parseAgentOutput } from "./agent-output-parser.js";

type Tool = "claude" | "codex";

interface Fragment {
  lines: string[];
  prompts?: string[];
  responses?: string[];
  statuses?: string[];
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

const mcpStartup = (tool: Tool, seed: number): Fragment => {
  const status = `MCP_STATUS_SENTINEL_${tool}_${seed}`;
  return {
    lines: [`• Starting MCP servers (1/4): ${status}, chrome-devtools (0s • esc to interrupt)`],
    statuses: [status],
  };
};

const fragmentMakersForTool = (tool: Tool) =>
  tool === "claude"
    ? ([activeInput, activityRow, feedbackSurvey, assistantMarkdown, mcpStartup] as const)
    : ([activeInput, activityRow, assistantMarkdown, mcpStartup] as const);

const collectByType = (raw: string, tool: Tool) => {
  const parsed = parseAgentOutput(raw, { tool });
  const grouped = new Map<AgentOutputBlockType, string>();
  for (const block of parsed.blocks) {
    grouped.set(block.type, `${grouped.get(block.type) ?? ""}\n${block.text}`);
  }
  return { parsed, grouped };
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

        expect(parseAgentOutput(raw, { tool }).blocks).toEqual(parsed.blocks);
        expect(parsed.blocks.map((block) => block.type)).not.toContain("raw");

        for (const prompt of fragments.flatMap((fragment) => fragment.prompts ?? [])) {
          expect(grouped.get("prompt") ?? "", `${tool} seed ${seed} prompt ${prompt}`).toContain(prompt);
        }
        for (const response of fragments.flatMap((fragment) => fragment.responses ?? [])) {
          expect(grouped.get("response") ?? "", `${tool} seed ${seed} response ${response}`).toContain(response);
        }
        for (const status of fragments.flatMap((fragment) => fragment.statuses ?? [])) {
          expect(grouped.get("status") ?? "", `${tool} seed ${seed} status ${status}`).toContain(status);
        }
        for (const forbidden of fragments.flatMap((fragment) => fragment.forbiddenPrompts ?? [])) {
          expect(grouped.get("prompt") ?? "", `${tool} seed ${seed} forbidden prompt ${forbidden}`).not.toContain(
            forbidden,
          );
        }
      });
    }
  }
});
