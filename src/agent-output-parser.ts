export type AgentOutputBlockType = "prompt" | "response" | "status" | "meta" | "raw";

export interface AgentOutputBlock {
  type: AgentOutputBlockType;
  text: string;
  sourceLines?: AgentOutputBlockSourceLine[];
}

export interface AgentOutputBlockSourceLine {
  lineIndex: number;
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
const activityRestForDurationRegex = new RegExp(String.raw`^for\s+${activityDurationPattern}(?:$|(?=\s*[·•.)]))`, "i");
const activityParentheticalDurationRegex = new RegExp(String.raw`\([^)]*\b${activityDurationPattern}\b[^)]*\)`, "i");
const activityEllipsisRegex = /\.{3}|…/;
const activityLeadRegex = /^[\p{Lu}][\p{L}-]{2,}\b/u;

const looksLikeActivityProgressText = (text: string) => {
  const trimmed = text.trim();
  const lead = trimmed.match(activityLeadRegex)?.[0] ?? "";
  if (!lead || !/(ed|ing)$/i.test(lead)) return false;
  const rest = trimmed.slice(lead.length).trimStart();
  if (
    !(
      activityRestForDurationRegex.test(rest) ||
      activityParentheticalDurationRegex.test(rest) ||
      activityEllipsisRegex.test(rest)
    )
  ) {
    return false;
  }
  return (
    activityForDurationRegex.test(trimmed) ||
    activityParentheticalDurationRegex.test(trimmed) ||
    activityEllipsisRegex.test(trimmed)
  );
};

const stripTerminalStatusMarker = (line: string) => line.trim().replace(/^[—–\-*✢✳✶✻✽·]\s+/, "");

const looksLikeTerminalStatusText = (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const unmarked = stripTerminalStatusMarker(trimmed);
  return (
    looksLikeActivityProgressText(unmarked) ||
    /^\d+\s+background terminals? running\b.*\b\/ps\b.*\b\/stop\b/i.test(unmarked)
  );
};

const looksLikeTerminalTailChromeStatusText = (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const unmarked = stripTerminalStatusMarker(trimmed);
  return (
    /^Worked\s+for\s+\d+(?:ms|s|m|h)\b/i.test(unmarked) ||
    /^\d+\s+background terminals? running\b.*\b\/ps\b.*\b\/stop\b/i.test(unmarked)
  );
};

const looksLikeRanCommandText = (text: string) => {
  const trimmed = text.trim();
  return (
    /^Ran\s+(?:aimux|bash|bun|cat|cd|curl|docker|find|gh|git|grep|ls|mkdir|mv|node|npm|pnpm|python3?|rg|rm|sed|sh|tsc|tsx|vercel|vitest|yarn)\b/i.test(
      trimmed,
    ) && !/[.!?]$/.test(trimmed)
  );
};

const looksLikeToolActionText = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return (
    /^Bash\([^)]*$/i.test(trimmed) ||
    /^(?:Bash|BashOutput|Edit|Explore|Glob|Grep|KillBash|LS|MultiEdit|NotebookEdit|Read|Task|TodoWrite|Update|WebFetch|WebSearch|Write)\s*(?:\([^)\n]*\)|\d+[^\n]*(?:ctrl\+o|to expand)|[^\n]*(?:Running in the background|exit code))\s*$/i.test(
      trimmed,
    ) ||
    /^Background command\s+".+"\s+completed\s+\(exit code\s+\d+\)/i.test(trimmed) ||
    looksLikeRanCommandText(trimmed) ||
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

/**
 * A rule with a caption sitting in it — `──── Some title ────`.
 *
 * Claude Code paints one of these as a footer and can leave it stale in the pane
 * long after the work it names is over. It is chrome, but `isDivider` only
 * recognises a line that is nothing but rule, so the captioned form used to
 * reach the transcript as prose and wrap across the chat.
 *
 * A leading conversation marker disqualifies it: the collapsed approval header is
 * `⏺` followed by a long rule and `Bash command`, and that line belongs to the
 * status rule which runs later.
 *
 * Module scope because both the line scanner and the raw-block promotion check
 * need it, and they live in different functions.
 */
function isTitledDivider(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || /^[⏺•⎿└╰■›>❯]/.test(trimmed)) return false;
  // Rule on both ends is the structural signature, and unlike counting rule
  // characters against the line length it does not move with the terminal
  // width: the caption is a fixed size while the rules stretch to fill, so a
  // ratio test catches this footer on a wide pane and misses it on a narrow one.
  return /^[\u2500-\u257f]{4,}[^\u2500-\u257f]+[\u2500-\u257f]{4,}$/.test(trimmed);
}

/**
 * Claude's pinned todo panel, wherever it lands.
 *
 * Usually it hangs off the status line as a `\u23bf` result, but between frames it
 * is drawn bare, with an `N tasks (\u2026)` header and no marker at all. U+25FB is
 * the checkbox in all 180 sampled captures; the others are here because the
 * glyph is a rendering detail, and prose does not open a line with any of them.
 */
function isTodoPanelLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^[\u23bf\u2514\s]*[\u25fb\u25a1\u2610\u2611\u2612]\s/.test(trimmed) ||
    /^\u2026\s*\+\d+\s+completed\b/.test(trimmed) ||
    /^\d+\s+tasks?\s*\(\d+\s+done\b/i.test(trimmed)
  );
}

/**
 * Half of a rule that the pane wrapped.
 *
 * The captioned rule closing the composer is wider than the pane, so it arrives
 * as `\u2500\u2500\u2500\u2500\u2500\u2500 Review custom` then `modules changes \u2500\u2500`. Neither half is a titled
 * divider, and both were reaching the transcript as prose.
 */
function isWrappedDividerFragment(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || /^[\u23fa\u2022\u23bf\u2514\u2570\u25a0\u203a>\u276f]/.test(trimmed)) return false;
  return /^[\u2500-\u257f]{4,}\s*\S/.test(trimmed) || /\S\s*[\u2500-\u257f]{3,}$/.test(trimmed);
}

export function parseAgentOutput(
  raw: string,
  options: { tool?: string; includeSource?: boolean } = {},
): ParsedAgentOutput {
  const requestedTool = (options.tool || "").trim();
  const tool = requestedTool && requestedTool !== "unknown" ? requestedTool : (inferAgentOutputTool(raw) ?? "unknown");
  const lines = String(raw || "")
    .replace(/\r/g, "")
    .split("\n");
  const blocks: AgentOutputBlock[] = [];
  type ActiveLine = { lineIndex: number; text: string };
  type ActiveBlock = { type: AgentOutputBlockType; lines: ActiveLine[] };
  let current: ActiveBlock | null = null;
  let sawPrompt = false;
  let expectingResponse = false;
  let lastLineWasDivider = false;

  const flush = () => {
    if (!current) return;
    const sourceLines = current.lines.slice();
    while (sourceLines.length > 0 && !sourceLines[sourceLines.length - 1]!.text) sourceLines.pop();
    const text = sourceLines
      .map((line) => line.text)
      .join("\n")
      .trimEnd();
    if (text) {
      blocks.push({
        type: current.type,
        text,
        ...(options.includeSource ? { sourceLines } : {}),
      });
    }
    current = null;
  };

  const pushLine = (type: AgentOutputBlockType, line: string, lineIndex: number) => {
    if (!current || current.type !== type) {
      flush();
      current = { type, lines: [] };
    }
    current.lines.push({ lineIndex, text: line });
  };

  const appendLine = (block: ActiveBlock, line: string, lineIndex: number) => {
    block.lines.push({ lineIndex, text: line });
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
      (/^[▘▝\s]+(~\/|\/)/.test(trimmed) && !sawPrompt) ||
      (isPathLike(trimmed) && !sawPrompt) ||
      (/context\)/.test(trimmed) && !sawPrompt)
    );
  };
  // Codex greets with account notices on the same bullet it uses for prose, so
  // they were reaching the chat as the agent's first message.
  const isCodexStartupNoticeLine = (line: string) => {
    const trimmed = line.trim().replace(/^[•*]\s+/, "");
    return (
      tool === "codex" &&
      !sawPrompt &&
      (/^You have \d+ usage limit resets? available\b/i.test(trimmed) || /^Tip:\s/i.test(trimmed))
    );
  };
  const isClaudeStartupStatusLine = (line: string) => {
    const trimmed = line.trim();
    return (
      tool === "claude" &&
      !sawPrompt &&
      (/^▎\s?/.test(trimmed) ||
        /^As before, you can use up to half of your weekly usage limit\b/i.test(trimmed) ||
        /^keep using Fable 5 with usage credits\b/i.test(trimmed) ||
        /^remaining limits\b/i.test(trimmed) ||
        /^More details here:?$/i.test(trimmed) ||
        /weekly rate limits\b/i.test(trimmed) ||
        /support\.claude\.com\/en\/articles\/15424964-claude-fable-5-promotional-access/i.test(trimmed))
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
  const isBoxTableContentLine = (line: string) => {
    const trimmed = line.trim();
    if (!/^│.*│$/.test(trimmed)) return false;
    const inner = trimmed.slice(1, -1).trim();
    return Boolean(inner) && inner.includes("│");
  };
  const isCodexUiLine = (line: string) => {
    const trimmed = line.trim();
    if (isBoxTableContentLine(trimmed)) return false;
    return /^│/.test(trimmed) || /^╰/.test(trimmed) || /^╭/.test(trimmed);
  };
  const isStatusLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    const dotBulletText = trimmed.replace(/^•\s?/, "");
    const starBulletText = trimmed.replace(/^\*\s+/, "");
    const dashBulletText = trimmed.replace(/^-\s+/, "");
    const terminalStatusText = stripTerminalStatusMarker(trimmed);
    const spinnerText = trimmed.replace(/^[✢✳✶✻✽·]\s+/, "");
    const conversationBulletText = trimmed.replace(/^(?:•|⏺)\s?/, "");
    return (
      /^■\s?/.test(trimmed) ||
      /^⚠\s+/.test(trimmed) ||
      /^⏺\s*$/.test(trimmed) ||
      /^⏺\s*[\u2500-\u257f\-_=\s]+Bash command\b/i.test(trimmed) ||
      /^⏺\s*Bash\([^)\n]*terminal-notifier/i.test(trimmed) ||
      /^⎿\s+\d+\s+skills?\s+available\b/i.test(trimmed) ||
      /^└\s+/.test(trimmed) ||
      looksLikeActivityProgressText(trimmed) ||
      /^•\s?Working\b/.test(trimmed) ||
      /^•\s?Starting MCP servers\b/.test(trimmed) ||
      /^•\s?How is Claude doing this session\?\s*\(optional\)/i.test(trimmed) ||
      /^You have \d+ usage limit resets available\b/i.test(dotBulletText) ||
      looksLikeRanCommandText(trimmed) ||
      looksLikeToolActionText(trimmed) ||
      (/^(?:•|⏺)\s?/.test(trimmed) && looksLikeToolActionText(conversationBulletText)) ||
      (/^•\s?/.test(trimmed) && looksLikeActivityProgressText(dotBulletText)) ||
      /^⏵⏵\s/.test(trimmed) ||
      (/^\*\s+/.test(trimmed) && looksLikeActivityProgressText(starBulletText)) ||
      (/^-\s+/.test(trimmed) && looksLikeActivityProgressText(dashBulletText)) ||
      (/^[—–]\s+/.test(trimmed) && looksLikeActivityProgressText(terminalStatusText)) ||
      (/^[✢✳✶✻✽·]\s+/.test(trimmed) && looksLikeActivityProgressText(spinnerText)) ||
      looksLikeTerminalStatusText(trimmed) ||
      /^[╰└]\s*Tip:/i.test(trimmed) ||
      /^Tip:\s/i.test(trimmed) ||
      /(Plan Mode|default permission mode)/i.test(trimmed) ||
      /Conversation interrupted/i.test(trimmed) ||
      /\bInterrupted\b.*\bwhat should\b.*\bdo instead\?/i.test(trimmed) ||
      /\bWorking \(\d+s/.test(trimmed)
    );
  };
  const isPromptLine = (line: string) => {
    return /^›\s?/.test(line) || /^>\s?/.test(line) || /^❯\s?/.test(line);
  };
  /**
   * The composer sits at column zero. An indented marker is something else —
   * tool output quoting a shell prompt, or a row inside a codex chooser.
   */
  const isIndentedMarkerLine = (line: string) => /^\s+(?:›|>|❯)\s?/.test(line);
  /**
   * A tool result hanging off the line above it — the agent's own output, never
   * the operator's typing. `⎿` (U+23BF) is what Claude Code actually prints;
   * `└` (U+2514) shows up in box drawing and is accepted for older transcripts.
   */
  const isToolResultLine = (line: string) => /^[⎿└]\s/.test(line.trimStart());
  const stripPromptMarker = (line: string) => line.trimStart().replace(/^(›|>|❯)\s?/, "");
  const stripResponseMarker = (line: string) => line.trimStart().replace(/^(•|⏺)\s?/, "");
  // Frame set matches the collapse check below; a partial set left half the
  // spinner frames unclassified, so the same line was status or response
  // depending on which frame the pane happened to be showing.
  const stripStatusMarker = (line: string) => line.trimStart().replace(/^(■|[—–\-*✢✳✶✻✽·]\s+)\s?/, "");
  const isCodexPickerSelectionPrompt = (promptText: string) => {
    if (tool !== "codex" || sawPrompt || (current?.type !== "response" && current?.type !== "raw")) return false;
    const activeText = current.lines.map((line) => line.text).join("\n");
    if (!/(?:Resume a previous session|Choose working directory to resume this session)/i.test(activeText)) {
      return false;
    }
    return /^(?:now|\d+[smhd]\s+ago|\d+\.\s)/i.test(promptText.trim());
  };
  const isCodexStartupSuggestionPrompt = (promptText: string) => {
    if (tool !== "codex" || sawPrompt) return false;
    return /^(?:Implement \{feature\}|Explain this codebase|Find and fix a bug in @filename)$/i.test(promptText.trim());
  };

  // The tool paints its composer, its captioned rules, its footer and its pinned
  // todo panel as one block at the bottom of the pane. None of it is transcript,
  // and cutting the whole block back to the last real line beats matching each
  // piece where it sits — every leak so far has been a new piece of this block.
  const isBottomChrome = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (/^[❯›>]$/.test(trimmed)) return true;
    return (
      isDivider(trimmed) ||
      isTitledDivider(trimmed) ||
      isWrappedDividerFragment(trimmed) ||
      isTodoPanelLine(trimmed) ||
      isFooterLine(trimmed) ||
      looksLikeTerminalTailChromeStatusText(trimmed)
    );
  };

  const trailingComposerBlockStart = () => {
    if (tool !== "claude") return null;
    let end = lines.length - 1;
    while (end >= 0 && !(lines[end] ?? "").trim()) end -= 1;
    if (end <= 0) return null;

    const tailText = (lines[end] ?? "").trim();
    if (!tailText || tailText.length > 220) return null;
    if (isPromptLine(lines[end] ?? "") || /^⏺|^●|^•/.test(tailText)) return null;
    if (isBottomChrome(lines[end] ?? "")) return null;

    let cursor = end - 1;
    let ruleCount = 0;
    let sawPromptMarker = false;
    while (cursor >= 0) {
      const trimmed = (lines[cursor] ?? "").trim();
      if (!trimmed) {
        cursor -= 1;
        continue;
      }
      if (isDivider(trimmed) || isTitledDivider(trimmed) || isWrappedDividerFragment(trimmed)) {
        ruleCount += 1;
        cursor -= 1;
        continue;
      }
      if (/^[❯›>]$/.test(trimmed)) {
        sawPromptMarker = true;
        cursor -= 1;
        continue;
      }
      break;
    }

    if (!sawPromptMarker) return null;
    const hasPriorConversation = lines
      .slice(0, cursor + 1)
      .some((line) => isPromptLine(line) || /^⏺|^●|^•/.test(line.trimStart()));
    return hasPriorConversation ? cursor + 1 : null;
  };

  let bodyEnd = lines.length;
  while (bodyEnd > 0 && isBottomChrome(lines[bodyEnd - 1] ?? "")) bodyEnd -= 1;
  bodyEnd = Math.min(bodyEnd, trailingComposerBlockStart() ?? bodyEnd);

  for (const [index, rawLine] of lines.entries()) {
    const trimmed = rawLine.trimEnd();

    // Status, not dropped: `blocks` is the low-level view and keeps the chrome,
    // while the chat projection is what discards it. Deleting here instead put
    // the two views out of step.
    if (index >= bodyEnd || isTodoPanelLine(trimmed)) {
      lastLineWasDivider = false;
      if (!trimmed.trim()) continue;
      if (isDivider(trimmed) || isTitledDivider(trimmed) || isWrappedDividerFragment(trimmed)) {
        continue;
      }
      pushLine("status", trimmed, index);
      continue;
    }
    if (isCodexUiLine(trimmed)) {
      lastLineWasDivider = false;
      pushLine(sawPrompt ? "status" : "meta", trimmed, index);
      continue;
    }
    if (isDivider(trimmed)) {
      lastLineWasDivider = true;
      continue;
    }
    // Clears the flag rather than merely not setting it. `lastLineWasDivider`
    // demotes a following prompt to status, which is right beneath the composer's
    // bare rule and wrong beneath a stale footer; leaving an earlier bare rule's
    // flag armed across this line deletes the operator's next message.
    if (isTitledDivider(trimmed)) {
      lastLineWasDivider = false;
      continue;
    }
    // A chooser row is indented under its header. It is not the operator typing,
    // but it is what they are choosing between, so it reads as status rather
    // than being dropped with the rest of the indented tool output.
    if (isIndentedMarkerLine(trimmed)) {
      const rowText = stripPromptMarker(trimmed);
      if (isCodexPickerSelectionPrompt(rowText)) {
        lastLineWasDivider = false;
        expectingResponse = false;
        if (rowText.trim()) pushLine("status", rowText, index);
        continue;
      }
    }
    if (isPromptLine(trimmed)) {
      const promptText = stripPromptMarker(trimmed);
      if (lastLineWasDivider) {
        if (promptText.trim()) pushLine("status", promptText, index);
        lastLineWasDivider = false;
        expectingResponse = false;
        continue;
      }
      lastLineWasDivider = false;
      if (isCodexPickerSelectionPrompt(promptText)) {
        if (promptText.trim()) pushLine("status", promptText, index);
        expectingResponse = false;
        continue;
      }
      if (isCodexStartupSuggestionPrompt(promptText)) {
        if (promptText.trim()) pushLine("status", promptText, index);
        expectingResponse = false;
        continue;
      }
      if (!promptText.trim()) {
        flush();
        expectingResponse = false;
        continue;
      }
      // Each marker line starts its own message. A prompt block still runs on
      // across unmarked lines, which is what keeps a pasted multi-line message
      // together — but two `❯` lines are two things the operator sent, and
      // appending the second to the first merged the queue into one bubble.
      flush();
      pushLine("prompt", promptText, index);
      sawPrompt = true;
      expectingResponse = false;
      continue;
    }
    lastLineWasDivider = false;
    if (isCodexStartupNoticeLine(trimmed)) {
      pushLine("status", trimmed, index);
      expectingResponse = false;
      continue;
    }
    if (/^(•|⏺)\s?/.test(trimmed) && !isStatusLine(trimmed)) {
      pushLine("response", stripResponseMarker(trimmed), index);
      sawPrompt = true;
      expectingResponse = false;
      continue;
    }
    if (isStatusLine(trimmed)) {
      pushLine("status", stripStatusMarker(trimmed), index);
      expectingResponse = false;
      continue;
    }
    if (isClaudeStartupStatusLine(trimmed)) {
      pushLine("status", trimmed.replace(/^▎\s?/, ""), index);
      expectingResponse = false;
      continue;
    }
    if (!sawPrompt && isClaudePreludeLine(trimmed)) {
      pushLine("meta", trimmed, index);
      continue;
    }
    if (isFooterLine(trimmed)) {
      pushLine("status", trimmed, index);
      expectingResponse = false;
      continue;
    }
    if (!trimmed.trim()) {
      const active = current as ActiveBlock | null;
      if (active && active.type !== "raw") {
        appendLine(active, "", index);
        if (active.type === "prompt") expectingResponse = true;
        continue;
      }
      flush();
      continue;
    }
    const promptBlock = current as ActiveBlock | null;
    // A prompt runs on across lines so a pasted multi-line message stays one
    // message. A tool result must not join it: it is the agent answering, and
    // absorbing it swallows everything after — including the next prompt, which
    // is how `/compact` and the question after it ended up in one bubble.
    const continuesPrompt = promptBlock?.type === "prompt" && !isToolResultLine(trimmed);
    if (continuesPrompt && !expectingResponse) {
      appendLine(promptBlock, trimmed, index);
      continue;
    }
    if (continuesPrompt && expectingResponse && /^\s+\S/.test(trimmed)) {
      appendLine(promptBlock, trimmed, index);
      expectingResponse = false;
      continue;
    }
    if (expectingResponse || (current as ActiveBlock | null)?.type === "response") {
      pushLine("response", trimmed, index);
      continue;
    }
    const active = current as ActiveBlock | null;
    if (active?.type === "meta" && isClaudePreludeLine(trimmed)) {
      appendLine(active, trimmed, index);
      continue;
    }
    if (active?.type === "status") {
      appendLine(active, trimmed, index);
      continue;
    }
    pushLine("raw", trimmed, index);
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
  const looksLikeRuntimeNoiseText = (text: string) => {
    const lines = String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const joined = lines.join("\n");
    const runtimeLineCount = lines.filter((line) => {
      return /^[✢✳✶✻✽·]/.test(line) || /^\(thinking\)$/i.test(line) || /^Bash\([^)]*terminal-notifier/i.test(line);
    }).length;
    return (
      runtimeLineCount >= 2 ||
      /terminal-notifier.*Running/i.test(joined) ||
      (/terminal-notifier/i.test(joined) &&
        /(?:Bash command|Thiscommandrequiresapproval|Doyouwanttoproceed)/i.test(joined))
    );
  };

  for (const block of next) {
    if (block.type === "raw" && looksLikeRuntimeNoiseText(block.text)) {
      block.type = "status";
    }
  }

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
    const leadingAssistantAfterMetaPrelude = prev?.type === "meta" && nextConversationIndex !== -1;
    const responseContinuation = prev?.type === "response";

    if (
      (betweenConversationTurns ||
        leadingAssistantCarryover ||
        leadingAssistantPrelude ||
        leadingAssistantAfterMetaPrelude ||
        responseContinuation) &&
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
    const hasPriorConversationTurn = next
      .slice(0, i)
      .some((block) => block.type === "prompt" || block.type === "response");
    const trailingFooterInput = nextConversationIndex === -1 && hasPriorConversationTurn;

    // A composer holding text is a prompt line wherever the pane draws it, so the
    // operator's message parses twice: once from the transcript, once from the
    // composer below the reply. Which status follows it only says whether the agent
    // is idle or mid-turn — the echo is an echo either way, and gating on the footer
    // alone left it standing for the whole turn, which is when it is on screen.
    const composerEchoBelow =
      following?.type === "status" &&
      (looksLikeFooterStatus(following.text) || looksLikeActiveWorkStatus(following.text));

    if (
      tool === "codex" &&
      composerEchoBelow &&
      (!hasActiveWorkBeforeNextTurn || repeatedPrompt || templatePrompt) &&
      (repeatedPrompt ||
        templatePrompt ||
        trailingFooterInput ||
        previous?.type === "response" ||
        (previous?.type === "status" && looksLikeActiveWorkStatus(previous.text)))
    ) {
      current.type = "status";
    }
  }

  if (
    !next.some((block) => block.type === "prompt" || block.type === "response") &&
    next.every((block) => block.type === "meta" || block.type === "status")
  ) {
    const metaText = next
      .filter((block) => block.type === "meta")
      .map((block) => block.text)
      .join("\n\n")
      .trim();
    const statusText = next
      .filter((block) => block.type === "status")
      .map((block) => block.text)
      .join("\n\n")
      .trim();
    const collapsed: AgentOutputBlock[] = [];
    if (metaText) collapsed.push({ type: "meta", text: metaText });
    if (statusText) collapsed.push({ type: "status", text: statusText });
    return collapsed;
  }

  const merged: AgentOutputBlock[] = [];
  for (const block of next) {
    const previous = merged[merged.length - 1];
    // Prompts are exempt: the agent's reply arrives in pieces and reads as one
    // message, but two marker lines are two things the operator sent, and
    // merging them collapsed a queued pair into a single bubble.
    if (previous && previous.type === block.type && block.type !== "prompt") {
      previous.text = `${previous.text}\n\n${block.text}`.trim();
      if (previous.sourceLines || block.sourceLines) {
        previous.sourceLines = [
          ...(previous.sourceLines ?? []),
          { lineIndex: -1, text: "" },
          ...(block.sourceLines ?? []),
        ];
      }
      continue;
    }
    merged.push(block);
  }

  return merged;
}

/**
 * The tool's own progress line — `Jitterbugging… (2m 23s · ↓ 8.1k tokens)`.
 *
 * Worth surfacing because it is the one part of the status chrome a person
 * actually reads: it names what the agent is doing and how long it has been at
 * it, in the tool's own words, where a client can otherwise only say "running".
 *
 * Scans lines rather than whole blocks: status blocks get merged, so the newest
 * progress line usually sits inside a block that also absorbed the footer, and
 * taking the last block's text would hand back a shell prompt.
 *
 * Past-tense leads are rejected. `Worked for 20m 16s` satisfies the same
 * progress shape but reports a finished turn, and rendering it live would put a
 * frozen timer next to an idle agent.
 */
export function activityTextFromParsedAgentOutput(parsed?: { blocks?: AgentOutputBlock[] } | null): string {
  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  let newest = "";
  for (const block of blocks) {
    if (block?.type !== "status") continue;
    for (const raw of String(block.text ?? "").split("\n")) {
      const line = raw.trim().replace(/^(■|[-*•✢✳✶✻✽·]\s+)\s?/, "");
      if (!line || !looksLikeActivityProgressText(line)) continue;
      const lead = line.match(activityLeadRegex)?.[0] ?? "";
      if (!/ing$/i.test(lead)) continue;
      // Bounded because a status block absorbs neighbouring lines: a long piece
      // of prose that happens to fit the progress shape would otherwise displace
      // the real verb and render as a paragraph in a one-line slot.
      if (line.length > 120) continue;
      // Codex ends its line with a keybinding, which is advice about a keyboard
      // the reader of a chat footer is not sitting at.
      newest = line.replace(/\s*[·•]\s*(?:esc|ctrl\+c)\s+to\s+interrupt/i, "");
    }
  }
  return newest;
}
