import type { AgentOutputBlockType } from "./agent-output-parser.js";

export interface AgentOutputParserContract {
  readonly blockTypes: ReadonlyArray<{
    readonly type: AgentOutputBlockType;
    readonly description: string;
  }>;
  readonly invariants: readonly string[];
}

export const AGENT_OUTPUT_PARSER_CONTRACT: AgentOutputParserContract = {
  blockTypes: [
    {
      type: "prompt",
      description: "User-authored input that was actually delivered to the agent.",
    },
    {
      type: "response",
      description: "Assistant-authored conversational output intended for chat history.",
    },
    {
      type: "status",
      description: "Transient runtime UI, progress, active input, suggestions, footers, or control-plane output.",
    },
    {
      type: "meta",
      description: "Startup chrome and non-conversational session metadata.",
    },
    {
      type: "raw",
      description: "Unclassified terminal text retained for diagnostics until a parser rule can classify it.",
    },
  ],
  invariants: [
    "Suggested prompts and active input placeholders must not become prompt blocks.",
    "Feedback/rating prompts must not become prompt blocks.",
    "A prompt block must represent user text that was submitted to the agent, not text merely visible in the terminal input row.",
    "Assistant text stays response text even when it contains prompt-looking markers, quotes, bullets, fences, or paths.",
    "Startup banners, footer/status lines, progress rows, and permission hints must not become response blocks.",
    "Activity/progress rows must remain status text with their exact activity wording preserved.",
    "Parsing the same complete transcript repeatedly should produce the same block sequence.",
  ],
};
