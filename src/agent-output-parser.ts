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

const activityDurationPattern = String.raw`\d+(?:ms|s|m|h)(?:\s+\d+(?:ms|s|m|h))*`;
const activityForDurationRegex = new RegExp(String.raw`\bfor\s+${activityDurationPattern}(?:$|(?=\s*[·•.)]))`, "i");
const activityParentheticalDurationRegex = new RegExp(String.raw`\([^)]*\b${activityDurationPattern}\b[^)]*\)`, "i");
const activityEllipsisRegex = /\.{3}|…/;
const activityLeadRegex = /^[\p{Lu}][\p{L}-]{2,}\b/u;

const looksLikeActivityProgressText = (text: string) => {
  const trimmed = text.trim();
  const lead = trimmed.match(activityLeadRegex)?.[0] ?? "";
  if (!lead || !/(ed|ing)$/i.test(lead)) return false;
  return (
    activityForDurationRegex.test(trimmed) ||
    activityParentheticalDurationRegex.test(trimmed) ||
    activityEllipsisRegex.test(trimmed)
  );
};

const looksLikeToolActionText = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return (
    /^(?:Bash|BashOutput|Edit|Explore|Glob|Grep|KillBash|LS|MultiEdit|NotebookEdit|Read|Task|TodoWrite|Update|WebFetch|WebSearch|Write)\s*(?:\(|\d|\b.*\b(?:ctrl\+o|to expand|Running in the background|exit code))/i.test(
      trimmed,
    ) ||
    /^Background command\s+".+"\s+completed\s+\(exit code\s+\d+\)/i.test(trimmed) ||
    /^Ran\s+(?:bash|bun|cat|cd|curl|docker|find|gh|git|grep|ls|mkdir|mv|node|npm|pnpm|python3?|rg|rm|sed|sh|tsc|tsx|vitest|yarn)\b/i.test(
      trimmed,
    ) ||
    /^Searched\s*for\s*\d+\s*patterns?/i.test(trimmed) ||
    /^Read\s*\d+\s*files?/i.test(trimmed)
  );
};

const inferAgentOutputTool = (raw: string): string | null => {
  const text = String(raw || "");
  const hasCodexChrome =
    /(?:^|\n)\s*(?:│\s*)?>_\s*OpenAI Codex\b/im.test(text) ||
    /(?:^|\n)\s*gpt-[\w.-]+\b.*(?:~\/|\/|permissions|context\))/im.test(text);
  const hasClaudeChrome =
    /(?:^|\n)\s*(?:│\s*)?Claude Code\b/im.test(text) ||
    /(?:^|\n)\s*claude\b.*(?:~\/|\/|permissions|context\))/im.test(text);
  if (hasCodexChrome && !hasClaudeChrome) {
    return "codex";
  }
  if (hasClaudeChrome && !hasCodexChrome) {
    return "claude";
  }
  return null;
};

export function parseAgentOutput(raw: string, options: { tool?: string } = {}): ParsedAgentOutput {
  const requestedTool = (options.tool || "").trim();
  const tool = requestedTool && requestedTool !== "unknown" ? requestedTool : (inferAgentOutputTool(raw) ?? "unknown");
  const lines = String(raw || "")
    .replace(/\r/g, "")
    .split("\n");
  const blocks: AgentOutputBlock[] = [];
  type ActiveBlock = { type: AgentOutputBlockType; lines: string[] };
  let current: ActiveBlock | null = null;
  let sawPrompt = false;
  let expectingResponse = false;
  let lastLineWasDivider = false;

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
      /^[A-Za-z0-9._-]+@[^ ]+\s+(~\/|\/)/.test(trimmed) ||
      (/^([›>]|▶)\s/.test(trimmed) && /(permissions|cycle|cwd|context)/i.test(trimmed)) ||
      /^⏵⏵\s/.test(trimmed) ||
      /^gpt-[\w.-]+\b.*(?:~\/|\/|context\)|permissions)/i.test(trimmed) ||
      /^claude\b.*(?:~\/|\/|context\)|permissions)/i.test(trimmed) ||
      /bypass permissions|shift\+tab|to cycle/i.test(trimmed)
    );
  };
  const isCodexUiLine = (line: string) => {
    const trimmed = line.trim();
    return /^│/.test(trimmed) || /^╰/.test(trimmed) || /^╭/.test(trimmed);
  };
  const isStatusLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    const dotBulletText = trimmed.replace(/^•\s?/, "");
    const starBulletText = trimmed.replace(/^\*\s+/, "");
    const dashBulletText = trimmed.replace(/^-\s+/, "");
    const spinnerText = trimmed.replace(/^[✻✽✶]\s+/, "");
    const conversationBulletText = trimmed.replace(/^(?:•|⏺)\s?/, "");
    return (
      /^■\s?/.test(trimmed) ||
      /^•\s?Working\b/.test(trimmed) ||
      /^•\s?Starting MCP servers\b/.test(trimmed) ||
      /^•\s?How is Claude doing this session\?\s*\(optional\)/i.test(trimmed) ||
      (/^(?:•|⏺)\s?/.test(trimmed) && looksLikeToolActionText(conversationBulletText)) ||
      (/^•\s?/.test(trimmed) && looksLikeActivityProgressText(dotBulletText)) ||
      /^⏵⏵\s/.test(trimmed) ||
      (/^\*\s+/.test(trimmed) && looksLikeActivityProgressText(starBulletText)) ||
      (/^-\s+/.test(trimmed) && looksLikeActivityProgressText(dashBulletText)) ||
      (/^[✻✽✶]\s+/.test(trimmed) && looksLikeActivityProgressText(spinnerText)) ||
      /^[╰└]\s*Tip:/i.test(trimmed) ||
      /^Tip:\s/i.test(trimmed) ||
      /(Plan Mode|default permission mode)/i.test(trimmed) ||
      /Conversation interrupted/i.test(trimmed) ||
      /\bInterrupted\b.*\bwhat should\b.*\bdo instead\?/i.test(trimmed) ||
      /\bWorking \(\d+s/.test(trimmed)
    );
  };
  const isPromptLine = (line: string) => {
    const trimmed = line.trimStart();
    return /^›\s?/.test(trimmed) || /^>\s?/.test(trimmed) || /^❯\s?/.test(trimmed);
  };
  const stripPromptMarker = (line: string) => line.trimStart().replace(/^(›|>|❯)\s?/, "");
  const stripResponseMarker = (line: string) => line.trimStart().replace(/^(•|⏺)\s?/, "");
  const stripStatusMarker = (line: string) => line.trimStart().replace(/^(■|[-*✻✽✶]\s+)\s?/, "");

  for (const line of lines) {
    const trimmed = line.trimEnd();

    if (isCodexUiLine(trimmed)) {
      lastLineWasDivider = false;
      pushLine(sawPrompt ? "status" : "meta", trimmed);
      continue;
    }
    if (isDivider(trimmed)) {
      lastLineWasDivider = true;
      continue;
    }
    if (isPromptLine(trimmed)) {
      const promptText = stripPromptMarker(trimmed);
      if (lastLineWasDivider) {
        if (promptText.trim()) pushLine("status", promptText);
        lastLineWasDivider = false;
        expectingResponse = false;
        continue;
      }
      lastLineWasDivider = false;
      if (!promptText.trim()) {
        flush();
        expectingResponse = false;
        continue;
      }
      pushLine("prompt", promptText);
      sawPrompt = true;
      expectingResponse = false;
      continue;
    }
    lastLineWasDivider = false;
    if (/^(•|⏺)\s?/.test(trimmed) && !isStatusLine(trimmed)) {
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
        if (active.type === "prompt") expectingResponse = true;
        continue;
      }
      flush();
      continue;
    }
    const promptBlock = current as ActiveBlock | null;
    if (promptBlock?.type === "prompt" && !expectingResponse) {
      promptBlock.lines.push(trimmed);
      continue;
    }
    if (promptBlock?.type === "prompt" && expectingResponse && /^\s+\S/.test(trimmed)) {
      promptBlock.lines.push(trimmed);
      expectingResponse = false;
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
    blocks: normalizeTranscriptBlocks(
      blocks.filter((block) => block.text.trim().length > 0),
      tool,
    ),
    parser: {
      tool,
      version: 1,
      confidence: "heuristic",
    },
  };
}

function normalizeTranscriptBlocks(blocks: AgentOutputBlock[], tool: string): AgentOutputBlock[] {
  const next = blocks.map((block) => ({ ...block }));

  const looksLikeFooterStatus = (text: string) => {
    return String(text || "")
      .split("\n")
      .some((line) => {
        const trimmed = line.trim();
        return (
          (/^([A-Za-z0-9._-]+@[^ ]+|~\/|\/)/.test(trimmed) && /(context\)|%\s|[$#]\s)/.test(trimmed)) ||
          /^gpt-[\w.-]+\b.*(?:~\/|\/|context\)|permissions)/i.test(trimmed) ||
          /^claude\b.*(?:~\/|\/|context\)|permissions)/i.test(trimmed) ||
          /bypass permissions|shift\+tab|to cycle/i.test(trimmed)
        );
      });
  };
  const looksLikeActiveWorkStatus = (text: string) =>
    String(text || "")
      .split("\n")
      .some((line) => {
        const trimmed = line.trim();
        return (
          /\bWorking \(\d+s\b.*\besc to interrupt\b/i.test(trimmed) ||
          /^Starting MCP servers\b/i.test(trimmed) ||
          looksLikeActivityProgressText(trimmed)
        );
      });
  const normalizedPromptText = (text: string) =>
    String(text || "")
      .trim()
      .replace(/\s+/g, " ");
  const promptCounts = new Map<string, number>();
  for (const block of next) {
    if (block.type !== "prompt") continue;
    const normalized = normalizedPromptText(block.text);
    if (!normalized) continue;
    promptCounts.set(normalized, (promptCounts.get(normalized) ?? 0) + 1);
  }
  const isTemplatePrompt = (text: string) => /\{[A-Za-z][A-Za-z0-9_-]*\}/.test(text);

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
    const nextConversationIndex = next.findIndex(
      (block, index) => index > i && (block.type === "prompt" || block.type === "response"),
    );

    const betweenConversationTurns =
      (prev?.type === "response" || prev?.type === "prompt") &&
      (following?.type === "prompt" || following?.type === "response");
    const leadingAssistantCarryover =
      !prev && (following?.type === "prompt" || following?.type === "response" || following?.type === "status");
    const leadingAssistantPrelude = !prev && nextConversationIndex !== -1;
    const responseContinuation = prev?.type === "response";

    if (
      (betweenConversationTurns || leadingAssistantCarryover || leadingAssistantPrelude || responseContinuation) &&
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

  for (let i = 0; i < next.length; i += 1) {
    const current = next[i];
    if (!current || current.type !== "prompt") continue;

    const previous = next[i - 1] || null;
    const following = next[i + 1] || null;
    const normalized = normalizedPromptText(current.text);
    const nextConversationIndex = next.findIndex(
      (block, index) => index > i && (block.type === "prompt" || block.type === "response"),
    );
    const intervening = next.slice(i + 1, nextConversationIndex === -1 ? undefined : nextConversationIndex);
    const hasActiveWorkBeforeNextTurn = intervening.some(
      (block) => block.type === "status" && looksLikeActiveWorkStatus(block.text),
    );
    const repeatedPrompt = (promptCounts.get(normalized) ?? 0) > 1;
    const templatePrompt = isTemplatePrompt(current.text);

    if (
      tool === "codex" &&
      following?.type === "status" &&
      looksLikeFooterStatus(following.text) &&
      (!hasActiveWorkBeforeNextTurn || repeatedPrompt || templatePrompt) &&
      (repeatedPrompt ||
        templatePrompt ||
        previous?.type === "response" ||
        (previous?.type === "status" && looksLikeActiveWorkStatus(previous.text)))
    ) {
      current.type = "status";
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
