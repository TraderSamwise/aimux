import type { AgentOutputBlockType } from "./agent-output-parser.js";

export interface AgentOutputParserFixture {
  name: string;
  tool: "claude" | "codex";
  raw: string;
  expected: Array<{
    type: AgentOutputBlockType;
    includes: string[];
    excludes?: string[];
  }>;
  invariants?: {
    noPromptIncludes?: string[];
  };
}

export const AGENT_OUTPUT_PARSER_FIXTURES: AgentOutputParserFixture[] = [
  {
    name: "claude-feedback-survey-input",
    tool: "claude",
    raw: [
      "⏺ There's our 2 at the top, then ~30 sequential Pine-related PRs (#584-616) — looks like autonomous-agent churn on",
      "  Pinescript compatibility.",
      "",
      "  Want a closer look at any particular one, or a diff stat to see what files changed?",
      "",
      "* Churned for 15s",
      "",
      "  4 tasks (3 done, 1 in progress, 0 open)",
      "  ✓ Soft-archive retiring channels (lock + pinned redirect)",
      "  ✓ Apply target category structure",
      "  ■ Refresh #start-here welcome post via webhook",
      "  ✓ Move non-secret Discord/Slack channel config out of .env",
      "",
      "• How is Claude doing this session? (optional)",
      "  1: Bad     2: Fine    3: Good    0: Dismiss",
      "",
      "────────────────────────────────────────────────────────────────────────────────────────────────",
      "❯ no that's fine, what's next?",
      "────────────────────────────────────────────────────────────────────────────────────────────────",
      "  sam@MacBook-Pro-4 ~/cs/tealstreet-next master ██░░░░38% Opus 4.7",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
    ].join("\n"),
    expected: [
      {
        type: "response",
        includes: ["There's our 2 at the top", "Want a closer look"],
      },
      {
        type: "status",
        includes: ["How is Claude doing this session?", "no that's fine, what's next?", "bypass permissions on"],
      },
    ],
    invariants: {
      noPromptIncludes: ["no that's fine, what's next?"],
    },
  },
  {
    name: "codex-repeated-template-suggestion",
    tool: "codex",
    raw: [
      "╭─────────────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.136.0)              │",
      "│                                         │",
      "│ model:       loading   /model to change │",
      "│ directory:   ~/cs/tealstreet-next       │",
      "│ permissions: YOLO mode                  │",
      "╰─────────────────────────────────────────╯",
      "",
      "› Implement {feature}",
      "",
      "  gpt-5.5 default · ~/cs/tealstreet-next/.aimux/worktrees/chat-sync",
      "",
      "╭─────────────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.136.0)              │",
      "│                                         │",
      "│ model:       gpt-5.5 medium   /model to change │",
      "│ directory:   ~/cs/tealstreet-next       │",
      "│ permissions: YOLO mode                  │",
      "╰─────────────────────────────────────────╯",
      "",
      "• Starting MCP servers (1/4): chrome-devtools, codex_apps, openaiDeveloperDocs (0s • esc to interrupt)",
      "",
      "› Implement {feature}",
      "",
      "  gpt-5.5 medium · ~/cs/tealstreet-next/.aimux/worktrees/chat-sync",
    ].join("\n"),
    expected: [
      {
        type: "meta",
        includes: ["OpenAI Codex"],
      },
      {
        type: "status",
        includes: ["Implement {feature}", "Starting MCP servers", "gpt-5.5 medium"],
      },
    ],
    invariants: {
      noPromptIncludes: ["Implement {feature}"],
    },
  },
  {
    name: "codex-active-image-input-followed-by-suggestion",
    tool: "codex",
    raw: [
      "› can you see this? Attached image files: - Screenshot.png (image/png, 120484 bytes): /Users/sam/cs/glyde-frontend/.aimux/attachments/att_3cbe0ace620a4e54aec6b885062ad615.png",
      "",
      "• Working (4s • esc to interrupt)",
      "",
      "› Explain this codebase",
      "",
      "  gpt-5.5 medium · ~/cs/glyde-frontend",
    ].join("\n"),
    expected: [
      {
        type: "prompt",
        includes: ["can you see this?", "Attached image files"],
      },
      {
        type: "status",
        includes: ["Working", "Explain this codebase", "gpt-5.5 medium"],
      },
    ],
    invariants: {
      noPromptIncludes: ["Explain this codebase"],
    },
  },
  {
    name: "codex-completed-state-suggestion",
    tool: "codex",
    raw: [
      "• A spiral wakes in ember light,",
      "  pink at the edge of morning.",
      "",
      "› Explain this codebase",
      "",
      "  gpt-5.5 medium · ~/cs/glyde-frontend",
    ].join("\n"),
    expected: [
      {
        type: "response",
        includes: ["A spiral wakes", "pink at the edge of morning"],
      },
      {
        type: "status",
        includes: ["Explain this codebase", "gpt-5.5 medium"],
      },
    ],
    invariants: {
      noPromptIncludes: ["Explain this codebase"],
    },
  },
  {
    name: "claude-real-prompt-that-matches-codex-suggestion",
    tool: "claude",
    raw: ["⏺ Ready when you are.", "", "❯ Explain this codebase", "", "  claude · ~/cs/glyde-frontend"].join("\n"),
    expected: [
      {
        type: "response",
        includes: ["Ready when you are."],
      },
      {
        type: "prompt",
        includes: ["Explain this codebase"],
      },
      {
        type: "status",
        includes: ["claude", "~/cs/glyde-frontend"],
      },
    ],
  },
];
