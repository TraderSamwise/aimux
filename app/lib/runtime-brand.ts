import { agentToolName, type AgentDisplayInput } from "@/lib/agent-display";

export type RuntimeBrandId = "claude" | "codex" | "aider" | "shell" | "service" | "unknown";

export interface RuntimeBrand {
  id: RuntimeBrandId;
  /** The real word, for anything that has room for it and for a screen reader. */
  label: string;
  /** Two letters, for a header that has no room for the word. */
  shortLabel: string;
  color: string;
  background: string;
}

const BRANDS: Record<RuntimeBrandId, RuntimeBrand> = {
  claude: {
    id: "claude",
    label: "Claude",
    shortLabel: "CL",
    color: "#f97316",
    background: "rgba(249, 115, 22, 0.14)",
  },
  codex: {
    id: "codex",
    label: "Codex",
    shortLabel: "CX",
    color: "#22c55e",
    background: "rgba(34, 197, 94, 0.14)",
  },
  aider: {
    id: "aider",
    label: "Aider",
    shortLabel: "AI",
    color: "#eab308",
    background: "rgba(234, 179, 8, 0.14)",
  },
  shell: {
    id: "shell",
    label: "Shell",
    shortLabel: "SH",
    color: "#38bdf8",
    background: "rgba(56, 189, 248, 0.14)",
  },
  service: {
    id: "service",
    label: "Service",
    shortLabel: "SV",
    color: "#a78bfa",
    background: "rgba(167, 139, 250, 0.14)",
  },
  unknown: {
    id: "unknown",
    label: "Agent",
    shortLabel: "AG",
    color: "#a1a1aa",
    background: "rgba(161, 161, 170, 0.14)",
  },
};

const TOOL_ALIASES: Record<string, RuntimeBrandId> = {
  bash: "shell",
  fish: "shell",
  sh: "shell",
  zsh: "shell",
};

/**
 * How a runtime is shown, from the tool name the product already decided.
 *
 * The tool itself is NOT decided here: `agentToolName` is the one answer for
 * that, mirrored in `native/crates/aimux-core/src/agent_display.rs` and already
 * read by the loops screen, the topology and the expose model. This only says
 * what that answer looks like, so a second surface cannot start calling the
 * same agent something else.
 *
 * Anything unrecognised is `unknown`, which reads "Agent" -- the word
 * `agentToolName` itself falls back to. Guessing Claude for a tool nobody has
 * taught this map would put the wrong name on someone's chat.
 */
/**
 * The shells, which arrive as whichever binary was launched.
 *
 * `agentToolName` answers with the command's first token, so a shell agent
 * says `zsh` or `bash`. Those are the same runtime wearing different names --
 * aliasing them is not a second opinion about which tool it is.
 */
export function runtimeBrandForTool(tool: string | null | undefined): RuntimeBrand {
  const normalized = (tool ?? "").trim().toLowerCase();
  // `hasOwn`, not `in`: `in` walks the prototype, so a tool named
  // `constructor` or `toString` would come back as something that is not a
  // brand at all, with an undefined short label to render.
  if (Object.hasOwn(BRANDS, normalized)) return BRANDS[normalized as RuntimeBrandId];
  if (Object.hasOwn(TOOL_ALIASES, normalized)) return BRANDS[TOOL_ALIASES[normalized]!];
  return BRANDS.unknown;
}

export function runtimeBrandForAgent(agent: AgentDisplayInput): RuntimeBrand {
  return runtimeBrandForTool(agentToolName(agent));
}
