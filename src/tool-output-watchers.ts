function tailLines(text: string, count = 12): string[] {
  return text.split("\n").slice(-count);
}

function lastMeaningfulLine(text: string): string {
  const lines = tailLines(text, 20)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

function classifyActiveTailError(text: string): { errorVisible: boolean; interruptedVisible: boolean } {
  const recentLines = tailLines(text, 20)
    .map((line) => line.trim())
    .filter(Boolean);
  if (recentLines.length === 0) {
    return { errorVisible: false, interruptedVisible: false };
  }

  const isInterruptedLine = (line: string) =>
    /conversation interrupted/i.test(line) || /\binterrupted\b.*\bwhat should\b.*\bdo instead\?/i.test(line);
  const isErrorLine = (line: string) =>
    isInterruptedLine(line) || /something went wrong/i.test(line) || /error:/i.test(line) || /failed:/i.test(line);

  let lastErrorIndex = -1;
  for (let index = recentLines.length - 1; index >= 0; index -= 1) {
    const line = recentLines[index];
    if (!isErrorLine(line)) continue;
    lastErrorIndex = index;
    break;
  }

  if (lastErrorIndex === -1) {
    return { errorVisible: false, interruptedVisible: false };
  }

  const laterMeaningfulLines = recentLines.slice(lastErrorIndex + 1);
  if (laterMeaningfulLines.length > 0) {
    return { errorVisible: false, interruptedVisible: false };
  }

  const interruptedVisible = recentLines.slice(0, lastErrorIndex + 1).some((line) => isInterruptedLine(line));
  return { errorVisible: true, interruptedVisible };
}

function tracksPromptReadiness(tool: string): boolean {
  const normalizedTool = tool.trim().toLowerCase();
  return normalizedTool === "claude" || normalizedTool === "codex";
}

function hasToolInputPrompt(tool: string, text: string, lastLine: string): boolean {
  const normalizedTool = tool.trim().toLowerCase();
  if (normalizedTool === "codex") {
    return /^\s*[›❯]\s?.*$/.test(lastLine) || /use \/skills to list available skills/i.test(text);
  }
  if (normalizedTool === "claude") {
    return (
      /^\s*[›>❯]\s?.*$/.test(lastLine) ||
      /use \/skills to list available skills/i.test(text) ||
      /find and fix a bug in @filename/i.test(text)
    );
  }
  return false;
}

function classifyToolUpdatePrompt(
  tool: string,
  text: string,
): {
  updatePromptVisible: boolean;
  blockedMessage?: string;
} {
  const normalizedTool = tool.trim().toLowerCase();
  if (normalizedTool === "codex") {
    const hasBanner = /update available!/i.test(text);
    const hasCommand = /npm install -g @openai\/codex/i.test(text);
    if (hasBanner && hasCommand) {
      return {
        updatePromptVisible: true,
        blockedMessage:
          "Codex update prompt detected. In-session update is not supported in aimux. Exit this agent, run `npm install -g @openai/codex`, then restart it.",
      };
    }
  }

  if (normalizedTool === "claude") {
    const hasClaudeHeader = /claude code/i.test(text);
    const hasCommand = /\bclaude (update|upgrade)\b/i.test(text);
    const hasUpdateLanguage = /\bupdate\b|\bupgrade\b/i.test(text);
    if (hasClaudeHeader && hasCommand && hasUpdateLanguage) {
      return {
        updatePromptVisible: true,
        blockedMessage:
          "Claude update prompt detected. In-session update is not supported in aimux. Exit this agent, run `claude update`, then restart it.",
      };
    }
  }

  return { updatePromptVisible: false };
}

export function classifyToolPane(
  tool: string,
  text: string,
): {
  promptVisible: boolean;
  errorVisible: boolean;
  interruptedVisible: boolean;
  updatePromptVisible: boolean;
  blockedMessage?: string;
} {
  const lastLine = lastMeaningfulLine(text);
  const { errorVisible, interruptedVisible } = classifyActiveTailError(text);
  const { updatePromptVisible, blockedMessage } = classifyToolUpdatePrompt(tool, text);
  const promptVisible = !updatePromptVisible && tracksPromptReadiness(tool) && hasToolInputPrompt(tool, text, lastLine);
  return { promptVisible, errorVisible, interruptedVisible, updatePromptVisible, blockedMessage };
}
