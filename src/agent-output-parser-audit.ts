import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseAgentOutput, type AgentOutputBlock } from "./agent-output-parser.js";

export type ParserAuditFindingFlag =
  | "prompt-from-response-record"
  | "raw-block"
  | "status-leak-response"
  | "action-status-leak";

export interface ParserAuditFinding {
  source: string;
  recordIndex?: number;
  tool: string;
  blockIndex: number;
  blockType: string;
  flags: ParserAuditFindingFlag[];
  sample: string;
}

export interface ParserAuditOptions {
  historyDirs?: string[];
  contextDirs?: string[];
  maxFindings?: number;
  flags?: ParserAuditFindingFlag[];
}

export interface ParserAuditSummary {
  scanned: number;
  findings: ParserAuditFinding[];
  countsByFlag: Record<ParserAuditFindingFlag, number>;
}

interface AuditCandidate {
  source: string;
  recordIndex?: number;
  recordType?: string;
  tool: string;
  content: string;
}

const STATUS_LEAK_RESPONSE_PATTERNS = [
  /(?:^|\n)\s*How is Claude doing this session/i,
  /(?:^|\n)\s*Starting MCP servers/i,
  /(?:^|\n)\s*(?:⏵⏵\s*)?bypass permissions/i,
  /(?:^|\n)\s*(?:⎿\s*)?Running in the background/i,
  /(?:^|\n)\s*(?:⏺\s*)?Bash\([^)]*terminal-notifier/i,
  /(?:^|\n)\s*(?:Thiscommandrequiresapproval|Doyouwanttoproceed)/i,
  /(?:^|\n)\s*(?:│\s*)?>_\s*OpenAI Codex\b/i,
  /^\s*(?:⏺\s*)?Bash\([^)\n]+\)\s*$/i,
  /^\s*(?:⏺\s*)?Read\s+\d+\s+files?(?:\s*\([^)\n]*ctrl\+o to expand[^)\n]*\))?\s*$/i,
] as const;

const ACTION_STATUS_LEAK_PATTERNS = [
  /(?:^|\n)\s*(?:[-*✻✽✶]\s+)?[\p{Lu}][\p{L}-]*(?:ed|ing)\b[^\n]*(?:\bfor\s+\d+(?:ms|s|m|h)|\.{3}|…|\([^)]*\b\d+(?:ms|s|m|h)\b[^)]*\))\s*(?=$|\n)/iu,
  /(?:^|\n)\s*(?:•\s*)?Working\s*\(\d+(?:ms|s|m|h)\b[^\n]*\)\s*(?=$|\n)/i,
  /(?:^|\n)\s*(?:•\s*)?Starting MCP servers\b[^\n]*(?=$|\n)/i,
  /(?:^|\n)\s*(?:•\s*)?Ran\s+(?:aimux|bash|bun|cat|cd|curl|docker|find|gh|git|grep|ls|mkdir|mv|node|npm|pnpm|python3?|rg|rm|sed|sh|tsc|tsx|vitest|yarn)\b(?![^\n]*(?:\.{3}|…|\b(?:was|is|now|earlier)\b))[^\n!?]*(?=$|\n)/i,
  /(?:^|\n)\s*(?:•|⏺)?\s*(?:Bash|BashOutput|Edit|Explore|Glob|Grep|KillBash|LS|MultiEdit|NotebookEdit|Read|Task|TodoWrite|Update|WebFetch|WebSearch|Write)\s*(?:\([^)\n]*\)|\d+[^\n]*(?:ctrl\+o|to expand)|[^\n]*(?:Running in the background|exit code))\s*(?=$|\n)/i,
  /(?:^|\n)\s*└\s+[^\n]*(?=$|\n)/,
] as const;

const emptyCounts = (): Record<ParserAuditFindingFlag, number> => ({
  "prompt-from-response-record": 0,
  "raw-block": 0,
  "status-leak-response": 0,
  "action-status-leak": 0,
});

const sampleText = (text: string) => String(text || "").replace(/\s+/g, " ").trim().slice(0, 320);

const toolForSource = (source: string) => {
  const basename = source.split("/").pop() ?? "";
  if (/^codex[-_]/i.test(basename) || /\/codex[-_]/i.test(source)) return "codex";
  if (/^claude[-_]/i.test(basename) || /\/claude[-_]/i.test(source)) return "claude";
  return "unknown";
};

const looksLikePromptLeakFooter = (block: AgentOutputBlock | null | undefined) => {
  if (!block || block.type !== "status") return false;
  if (/Conversation interrupted/i.test(block.text)) return false;
  if (/(?:^|\n)\s*(?:•\s*)?(?:Working \(\d+(?:ms|s|m|h)|Starting MCP servers)/i.test(block.text)) return false;
  return /(?:^|\n)\s*(?:gpt-[\w.-]+\b|claude\b|⏵⏵\s*bypass permissions|bypass permissions|.*context\)|.*permissions:)/i.test(
    block.text,
  );
};

const promptLeakLooksActionable = (blocks: AgentOutputBlock[], blockIndex: number) => {
  const prompt = blocks[blockIndex];
  if (!prompt || prompt.text.trim().length < 3) return false;
  return looksLikePromptLeakFooter(blocks[blockIndex + 1]);
};

const rawBlockLooksActionable = (text: string) => {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim().replace(/^\d+\s+(?:[+-]\s*)?/, ""))
    .filter(Boolean);
  if (lines.length === 0) return false;
  if (lines.every((line) => /^[{}\][(),;:\s]+$/.test(line))) return false;
  if (lines.every((line) => /^[\d⋮\s:+\-{},()[\];"\u2500-\u257f]+$/.test(line))) return false;
  if (lines.every((line) => /^[bcdlps-][rwx-]{9}@?\s+\d+\s+\S+\s+\S+\s+\d+\s+\w{3}\s+\d+/i.test(line))) {
    return false;
  }
  return true;
};

function* historyCandidates(historyDir: string): Generator<AuditCandidate> {
  if (!existsSync(historyDir) || !statSync(historyDir).isDirectory()) return;
  for (const entry of readdirSync(historyDir).filter((name) => name.endsWith(".jsonl")).sort()) {
    const source = join(historyDir, entry);
    const tool = toolForSource(source);
    const lines = readFileSync(source, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      let record: { type?: unknown; content?: unknown };
      try {
        record = JSON.parse(line) as { type?: unknown; content?: unknown };
      } catch {
        continue;
      }
      if (typeof record.content !== "string") continue;
      if (record.type !== "response") continue;
      yield {
        source,
        recordIndex: index,
        recordType: String(record.type),
        tool,
        content: record.content,
      };
    }
  }
}

function* contextCandidates(contextDir: string): Generator<AuditCandidate> {
  if (!existsSync(contextDir) || !statSync(contextDir).isDirectory()) return;
  const stack = [contextDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of readdirSync(dir).sort()) {
      const source = join(dir, entry);
      const stats = statSync(source);
      if (stats.isDirectory()) {
        stack.push(source);
        continue;
      }
      if (entry !== "live.md" && entry !== "summary.md") continue;
      yield {
        source,
        tool: toolForSource(source),
        content: readFileSync(source, "utf8"),
      };
    }
  }
}

export function auditAgentOutputParserCorpus(options: ParserAuditOptions): ParserAuditSummary {
  const findings: ParserAuditFinding[] = [];
  const countsByFlag = emptyCounts();
  let scanned = 0;
  const maxFindings = options.maxFindings ?? Number.POSITIVE_INFINITY;

  const candidates = [
    ...(options.historyDirs ?? []).flatMap((dir) => Array.from(historyCandidates(dir))),
    ...(options.contextDirs ?? []).flatMap((dir) => Array.from(contextCandidates(dir))),
  ];

  for (const candidate of candidates) {
    scanned += 1;
    const parsed = parseAgentOutput(candidate.content, { tool: candidate.tool });
    parsed.blocks.forEach((block, blockIndex) => {
      const flags: ParserAuditFindingFlag[] = [];
      if (block.type === "raw" && rawBlockLooksActionable(block.text)) {
        flags.push("raw-block");
      }
      if (block.type === "response" && STATUS_LEAK_RESPONSE_PATTERNS.some((pattern) => pattern.test(block.text))) {
        flags.push("status-leak-response");
      }
      if (block.type === "response" && ACTION_STATUS_LEAK_PATTERNS.some((pattern) => pattern.test(block.text))) {
        flags.push("action-status-leak");
      }
      if (
        candidate.recordType === "response" &&
        block.type === "prompt" &&
        promptLeakLooksActionable(parsed.blocks, blockIndex)
      ) {
        flags.push("prompt-from-response-record");
      }
      if (options.flags && options.flags.length > 0) {
        for (let index = flags.length - 1; index >= 0; index -= 1) {
          if (!options.flags.includes(flags[index] as ParserAuditFindingFlag)) {
            flags.splice(index, 1);
          }
        }
      }
      if (flags.length === 0) return;
      for (const flag of flags) {
        countsByFlag[flag] += 1;
      }
      if (findings.length >= maxFindings) return;
      findings.push({
        source: candidate.source,
        recordIndex: candidate.recordIndex,
        tool: parsed.parser.tool,
        blockIndex,
        blockType: block.type,
        flags,
        sample: sampleText(block.text),
      });
    });
  }

  return { scanned, findings, countsByFlag };
}
