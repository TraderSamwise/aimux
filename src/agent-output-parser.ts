export type AgentOutputBlockType = "prompt" | "response" | "status" | "meta" | "raw";

export interface AgentOutputBlock {
  type: AgentOutputBlockType;
  text: string;
}

export interface ParsedAgentOutput {
  blocks: AgentOutputBlock[];
  parser: {
    tool: string;
    version: number;
    confidence: "heuristic";
  };
}

export function parseAgentOutput(raw: string, options: { tool?: string } = {}): ParsedAgentOutput {
  const tool = (options.tool || "unknown").trim() || "unknown";
  const lines = String(raw || "")
    .replace(/\r/g, "")
    .split("\n");
  const blocks: AgentOutputBlock[] = [];
  type ActiveBlock = { type: AgentOutputBlockType; lines: string[] };
  let current: ActiveBlock | null = null;
  let sawPrompt = false;
  let expectingResponse = false;

  const flush = () => {
    if (!current) return;
    const text = current.lines.join("\n").trimEnd();
    if (text) blocks.push({ type: current.type, text });
    current = null;
  };

  const pushLine = (type: AgentOutputBlockType, line: string) => {
    if (!current || current.type !== type) {
      flush();
      current = { type, lines: [] };
    }
    current.lines.push(line);
  };

  const isDivider = (line: string) => {
    const trimmed = line.trim();
    return Boolean(trimmed) && /^[\u2500-\u257f\-_=\s]+$/.test(trimmed);
  };

  const isPathLike = (line: string) => /(^~\/|^\/|^[A-Za-z]:\\)/.test(line.trim());
  const isClaudePreludeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return current?.type === "meta";
    return (
      trimmed.includes("Claude Code") ||
      trimmed.includes("Claude Max") ||
      trimmed.includes("Sonnet") ||
      trimmed.includes("Opus") ||
      (isPathLike(trimmed) && !sawPrompt) ||
      (/context\)/.test(trimmed) && !sawPrompt)
    );
  };
  const isFooterLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    return (
      (/^([A-Za-z0-9._-]+@[^ ]+|~\/|\/)/.test(trimmed) && /(context\)|%\s|[$#]\s)/.test(trimmed)) ||
      (/^([›>]|▶)\s/.test(trimmed) && /(permissions|cycle|cwd|context)/i.test(trimmed)) ||
      /gpt-|claude|context\)|bypass permissions|shift\+tab|to cycle/i.test(trimmed)
    );
  };
  const isStatusLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    return (
      /^■\s?/.test(trimmed) ||
      /^•\s?Working\b/.test(trimmed) ||
      /^\*\s+[A-Z][A-Za-z-]+(?:\.\.\.|…)?$/.test(trimmed) ||
      /^[╰└]\s*Tip:/i.test(trimmed) ||
      /^Tip:\s/i.test(trimmed) ||
      /(Plan Mode|default permission mode)/i.test(trimmed) ||
      /Conversation interrupted/i.test(trimmed) ||
      /\bWorking \(\d+s/.test(trimmed)
    );
  };
  const isPromptLine = (line: string) => {
    const trimmed = line.trimStart();
    return /^›\s?/.test(trimmed) || /^>\s?/.test(trimmed);
  };
  const stripPromptMarker = (line: string) => line.trimStart().replace(/^(›|>)\s?/, "");
  const stripResponseMarker = (line: string) => line.trimStart().replace(/^•\s?/, "");
  const stripStatusMarker = (line: string) => line.trimStart().replace(/^(■|\*\s+)\s?/, "");

  for (const line of lines) {
    const trimmed = line.trimEnd();

    if (isDivider(trimmed)) continue;
    if (isPromptLine(trimmed)) {
      pushLine("prompt", stripPromptMarker(trimmed));
      sawPrompt = true;
      expectingResponse = true;
      continue;
    }
    if (/^•\s?/.test(trimmed) && !/^•\s?Working\b/.test(trimmed)) {
      pushLine("response", stripResponseMarker(trimmed));
      sawPrompt = true;
      expectingResponse = false;
      continue;
    }
    if (isStatusLine(trimmed)) {
      pushLine("status", stripStatusMarker(trimmed));
      expectingResponse = false;
      continue;
    }
    if (!sawPrompt && isClaudePreludeLine(trimmed)) {
      pushLine("meta", trimmed);
      continue;
    }
    if (isFooterLine(trimmed)) {
      pushLine("status", trimmed);
      expectingResponse = false;
      continue;
    }
    if (!trimmed.trim()) {
      const active = current as ActiveBlock | null;
      if (active && active.type !== "raw") {
        active.lines.push("");
        continue;
      }
      flush();
      continue;
    }
    if (expectingResponse || (current as ActiveBlock | null)?.type === "response") {
      pushLine("response", trimmed);
      continue;
    }
    const active = current as ActiveBlock | null;
    if (active?.type === "meta" && isClaudePreludeLine(trimmed)) {
      active.lines.push(trimmed);
      continue;
    }
    if (active?.type === "status") {
      active.lines.push(trimmed);
      continue;
    }
    pushLine("raw", trimmed);
  }

  flush();

  return {
    blocks: normalizeTranscriptBlocks(blocks.filter((block) => block.text.trim().length > 0)),
    parser: {
      tool,
      version: 1,
      confidence: "heuristic",
    },
  };
}

function normalizeTranscriptBlocks(blocks: AgentOutputBlock[]): AgentOutputBlock[] {
  const next = blocks.map((block) => ({ ...block }));

  const looksLikeAssistantText = (text: string) => {
    const trimmed = String(text || "").trim();
    if (!trimmed) return false;
    if (/^(sam@|[A-Za-z0-9._-]+@|~\/|\/)/.test(trimmed)) return false;
    if (/^(bypass permissions|shift\+tab|context\)|gpt-|claude )/i.test(trimmed)) return false;
    if (/^[\u2500-\u257f\-_=\s]+$/.test(trimmed)) return false;
    return /[A-Za-z]/.test(trimmed);
  };

  for (let i = 0; i < next.length; i += 1) {
    const current = next[i];
    if (!current || current.type !== "raw") continue;

    const prev = next[i - 1] || null;
    const following = next[i + 1] || null;

    const betweenConversationTurns =
      (prev?.type === "response" || prev?.type === "prompt") &&
      (following?.type === "prompt" || following?.type === "response");
    const leadingAssistantCarryover =
      !prev && (following?.type === "prompt" || following?.type === "response" || following?.type === "status");
    const responseContinuation = prev?.type === "response";

    if (
      (betweenConversationTurns || leadingAssistantCarryover || responseContinuation) &&
      looksLikeAssistantText(current.text)
    ) {
      current.type = "response";
    }
  }

  const hasConversationTurns = next.some((block) => block.type === "prompt" || block.type === "response");
  if (!hasConversationTurns) {
    for (const block of next) {
      if (block.type !== "raw") continue;
      if (!looksLikeAssistantText(block.text)) continue;
      block.type = "response";
    }
  }

  let sawConversationTurn = false;
  for (const block of next) {
    if (block.type === "prompt" || block.type === "response") {
      sawConversationTurn = true;
      continue;
    }
    if (block.type === "raw" && sawConversationTurn && looksLikeAssistantText(block.text)) {
      block.type = "response";
    }
  }

  const merged: AgentOutputBlock[] = [];
  for (const block of next) {
    const previous = merged[merged.length - 1];
    if (previous && previous.type === block.type) {
      previous.text = `${previous.text}\n\n${block.text}`.trim();
      continue;
    }
    merged.push(block);
  }

  return merged;
}
