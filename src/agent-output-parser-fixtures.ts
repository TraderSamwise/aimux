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
      "  user@host ~/workspace/project master ██░░░░38% Opus 4.7",
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
      "│ directory:   ~/workspace/project        │",
      "│ permissions: YOLO mode                  │",
      "╰─────────────────────────────────────────╯",
      "",
      "› Implement {feature}",
      "",
      "  gpt-5.5 default · ~/workspace/project/.aimux/worktrees/chat-sync",
      "",
      "╭─────────────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.136.0)              │",
      "│                                         │",
      "│ model:       gpt-5.5 medium   /model to change │",
      "│ directory:   ~/workspace/project        │",
      "│ permissions: YOLO mode                  │",
      "╰─────────────────────────────────────────╯",
      "",
      "• Starting MCP servers (1/4): chrome-devtools, codex_apps, openaiDeveloperDocs (0s • esc to interrupt)",
      "",
      "› Implement {feature}",
      "",
      "  gpt-5.5 medium · ~/workspace/project/.aimux/worktrees/chat-sync",
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
    name: "codex-resume-session-picker-selection",
    tool: "codex",
    raw: [
      "Resume a previous session",
      " Type to search                                                       Filter:  Cwd [All]   Sort: [Updated] Created",
      "  ❯ now         Saved as ~/cs/hyperprop/HANDOFF.md. Here it is:  ---  What: Decentralized eval prop firm on...",
      "    1m ago      previous agent was in a compact loop.TL;DR: we were trying to fix the iOS chat composer bein...",
      "    15h ago     reply exactly CODEX_PROTOCOL_OK",
    ].join("\n"),
    expected: [
      {
        type: "response",
        includes: ["Resume a previous session", "Type to search"],
      },
      {
        type: "status",
        includes: ["now", "previous agent was in a compact loop", "CODEX_PROTOCOL_OK"],
      },
    ],
    invariants: {
      noPromptIncludes: ["Saved as ~/cs/hyperprop/HANDOFF.md", "previous agent was in a compact loop"],
    },
  },
  {
    name: "codex-working-directory-picker-selection",
    tool: "codex",
    raw: [
      "Choose working directory to resume this session",
      "  Session = latest cwd recorded in the resumed session",
      "  Current = your current working directory",
      "  1. Use session directory (/Users/sam/cs/aimux)",
      "› 2. Use current directory (/Users/sam/cs/aimux/.aimux/worktrees/chat-parser)",
      "  Press enter to continue",
      "│ >_ OpenAI Codex (v0.136.0)                           │",
      "│                                                      │",
      "│ model:       gpt-5.5 high   /model to change         │",
      "│ directory:   ~/cs/aimux/.aimux/worktrees/chat-parser │",
      "│ permissions: YOLO mode                               │",
    ].join("\n"),
    expected: [
      {
        type: "response",
        includes: ["Choose working directory", "Use session directory"],
      },
      {
        type: "status",
        includes: ["2. Use current directory", "Press enter to continue"],
      },
      {
        type: "meta",
        includes: ["OpenAI Codex", "permissions: YOLO mode"],
      },
    ],
    invariants: {
      noPromptIncludes: ["2. Use current directory"],
    },
  },
  {
    name: "codex-live-startup-suggestion-loop",
    tool: "codex",
    raw: [
      "│ >_ OpenAI Codex (v0.136.0)                      │",
      "│                                                 │",
      "│ model:       loading   /model to change         │",
      "│ directory:   ~/workspace/project/.aimux/worktrees/polish │",
      "│ permissions: YOLO mode                          │",
      "› Explain this codebase",
      "  gpt-5.5 default · ~/workspace/project/.aimux/worktrees/polish",
      "│ >_ OpenAI Codex (v0.136.0)                      │",
      "│                                                 │",
      "│ model:       loading   /model to change         │",
      "│ directory:   ~/workspace/project/.aimux/worktrees/polish │",
      "│ permissions: YOLO mode                          │",
      "• Starting MCP servers (0/4): chrome-devtools, codex_apps, node_repl, … (0s • esc to interrupt)",
      "› Explain this codebase",
      "  gpt-5.5 default · ~/workspace/project/.aimux/worktrees/polish",
      "│ >_ OpenAI Codex (v0.136.0)                      │",
      "│                                                 │",
      "│ model:       gpt-5.5 high   /model to change    │",
      "│ directory:   ~/workspace/project/.aimux/worktrees/polish │",
      "│ permissions: YOLO mode                          │",
      "  Tip: Press Tab to queue a message when a task is running; otherwise it sends immediately (except !).",
      "› Explain this codebase",
      "  gpt-5.5 high · ~/workspace/project/.aimux/worktrees/polish",
    ].join("\n"),
    expected: [
      {
        type: "meta",
        includes: ["OpenAI Codex"],
      },
      {
        type: "status",
        includes: ["Explain this codebase", "Starting MCP servers", "Press Tab to queue a message"],
      },
    ],
    invariants: {
      noPromptIncludes: ["Explain this codebase"],
    },
  },
  {
    name: "codex-active-image-input-followed-by-suggestion",
    tool: "codex",
    raw: [
      "› can you see this? Attached image files: - Screenshot.png (image/png, 120484 bytes): /workspace/project/.aimux/attachments/att_example.png",
      "",
      "• Working (4s • esc to interrupt)",
      "",
      "› Explain this codebase",
      "",
      "  gpt-5.5 medium · ~/workspace/project",
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
    name: "codex-trailing-suggestion-after-status-output",
    tool: "codex",
    raw: [
      "• This worktree looks clean and usable.",
      "",
      "• Ran git branch -vv && git rev-parse --abbrev-ref --symbolic-full-name @{u}",
      "  └ ## chat-parser",
      "",
      "› Explain this codebase",
      "",
      "  gpt-5.5 high · ~/workspace/project",
    ].join("\n"),
    expected: [
      {
        type: "response",
        includes: ["This worktree looks clean"],
      },
      {
        type: "status",
        includes: ["Ran git branch", "Explain this codebase", "gpt-5.5 high"],
      },
    ],
    invariants: {
      noPromptIncludes: ["Explain this codebase"],
    },
  },
  {
    name: "codex-command-output-tree-summary",
    tool: "codex",
    raw: [
      "• Ran aimux daemon project-ensure --project /Users/sam/cs/hyperprop --json",
      "  └ {",
      '      "project": {',
      "    … +5 lines (ctrl + t to view transcript)",
      "      }",
      "    }",
      "",
      "• The prod ensure completed.",
    ].join("\n"),
    expected: [
      {
        type: "status",
        includes: ["Ran aimux daemon project-ensure", "└ {", "ctrl + t to view transcript"],
      },
      {
        type: "response",
        includes: ["The prod ensure completed"],
      },
    ],
  },
  {
    name: "codex-result-summary-after-metadata-path",
    tool: "codex",
    raw: [
      "~/.aimux/projects.json.backup-2026-06-06T06-44-29-597Z",
      "  Result:",
      "  - Registry: 23087 -> 6",
      "  - Live /projects: now ~0.24-0.51s",
      "  - Remaining projects: aimux, hyperprop, premys",
      "",
      "› Open a PR. run review-coderabbit until green. then merge and cut new branch.",
      "■ Conversation interrupted - tell the model what to do differently.",
    ].join("\n"),
    expected: [
      {
        type: "meta",
        includes: ["projects.json.backup"],
      },
      {
        type: "response",
        includes: ["Result:", "Registry: 23087 -> 6", "Remaining projects"],
      },
      {
        type: "prompt",
        includes: ["Open a PR"],
      },
      {
        type: "status",
        includes: ["Conversation interrupted"],
      },
    ],
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
      "  gpt-5.5 medium · ~/workspace/project",
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
    raw: ["⏺ Ready when you are.", "", "❯ Explain this codebase", "", "  claude · ~/workspace/project"].join("\n"),
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
        includes: ["claude", "~/workspace/project"],
      },
    ],
  },
  {
    name: "claude-multi-unit-activity-status",
    tool: "claude",
    raw: [
      "⏺ Good question — and I can actually check it, rather than take it on faith.",
      "",
      "* Cooked for 1m 2s · 1 shell still running",
      "",
      "  user@host ~/workspace/project master ██░░░░5% Opus 4.8",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
    ].join("\n"),
    expected: [
      {
        type: "response",
        includes: ["Good question"],
      },
      {
        type: "status",
        includes: ["Cooked for 1m 2s · 1 shell still running", "bypass permissions on"],
      },
    ],
  },
  {
    name: "claude-live-tool-action-rows",
    tool: "claude",
    raw: [
      "⏺ Good question. Let me check the relay status.",
      "",
      "⏺ Bash(cd /workspace/project; gh pr checks 5968)",
      "  ⎿  Running in the background (down arrow to manage)",
      "",
      "⏺ Read 2 files (ctrl+o to expand)",
      "",
      "⏺ Update(src/relay.ts)",
      "",
      "⏺ All checks are green. I can merge now.",
    ].join("\n"),
    expected: [
      {
        type: "response",
        includes: ["Good question"],
        excludes: ["Bash(cd", "Read 2 files", "Update(src/relay.ts)"],
      },
      {
        type: "status",
        includes: ["Bash(cd", "Running in the background", "Read 2 files", "Update(src/relay.ts)"],
      },
      {
        type: "response",
        includes: ["All checks are green"],
      },
    ],
  },
  {
    name: "claude-malformed-animation-status",
    tool: "claude",
    raw: [
      "────────────────────────────────────────────────────────────────────────────────────────────────",
      "user@host ~/workspace/project main Opus4.6(1Mcontext)",
      "✢n",
      "g",
      "·…",
      "✻Bew",
      "ri",
      "✶en",
      "win…",
      "(thinking)",
      "·Brewing… (thinking)",
      'Bash(terminal-notifier-title"ClaudeCode"-message"Notificationtest-sessionstarted"-sounddefault)\r⎿ Running…',
      "✢ Brewing… (thinking)",
      "────────────────────────────────────────────────────────────────────────────────────────────────",
    ].join("\n"),
    expected: [
      {
        type: "meta",
        includes: ["user@host ~/workspace/project"],
      },
      {
        type: "status",
        includes: ["Brewing… (thinking)", "terminal-notifier"],
      },
    ],
  },
  {
    name: "claude-collapsed-approval-status",
    tool: "claude",
    raw: [
      "────────────────────────────────────────────────────────────────────────────────────────────────",
      "Brewing…",
      "⏺\r────────────────────────────────────────────────────────────────────────────────────────────────\rBash command\r",
      '   terminal-notifier-title"ClaudeCode"-message"Notificationtest-sessionstarted"-sounddefault',
      "   Test notification at session start",
      "Thiscommandrequiresapproval",
      "Doyouwanttoproceed?",
      "7;185;249m❯1.Yes",
      "2.Yes,anddon’taskagainfor:terminal-notifier:*",
      "3.No",
      "Esctocancel·Tabtoamend·ctrl+etoexplain",
    ].join("\n"),
    expected: [
      {
        type: "status",
        includes: ["Brewing…", "Thiscommandrequiresapproval", "Doyouwanttoproceed?"],
      },
    ],
  },
  {
    name: "codex-unknown-activity-verb-status",
    tool: "codex",
    raw: ["› run the thing", "", "* Carbonated for 42s", "", "  gpt-5.5 medium · ~/workspace/project"].join("\n"),
    expected: [
      {
        type: "prompt",
        includes: ["run the thing"],
      },
      {
        type: "status",
        includes: ["Carbonated for 42s", "gpt-5.5 medium"],
      },
    ],
  },
  {
    name: "codex-ellipsis-activity-status",
    tool: "codex",
    raw: [
      "› continue",
      "",
      "* Indexing… (running stop hook · 11s · ↓ 16 tokens)",
      "",
      "  gpt-5.5 medium · ~/workspace/project",
    ].join("\n"),
    expected: [
      {
        type: "prompt",
        includes: ["continue"],
      },
      {
        type: "status",
        includes: ["Indexing… (running stop hook · 11s · ↓ 16 tokens)", "gpt-5.5 medium"],
      },
    ],
  },
  {
    name: "codex-dash-activity-status",
    tool: "codex",
    raw: [
      "• PR #5914 is merged.",
      "",
      "- Worked for 20m 16s",
      "",
      "────────────────────────────────────────────────────────────────────────────────────────────────",
      "› Find and fix a bug in @filename",
      "────────────────────────────────────────────────────────────────────────────────────────────────",
      "  gpt-5.5 medium · ~/workspace/project · Main [default]",
    ].join("\n"),
    expected: [
      {
        type: "response",
        includes: ["PR #5914 is merged."],
      },
      {
        type: "status",
        includes: ["Worked for 20m 16s", "Find and fix a bug in @filename", "gpt-5.5 medium"],
      },
    ],
    invariants: {
      noPromptIncludes: ["Find and fix a bug in @filename"],
    },
  },
];
