import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseAgentOutput } from "./agent-output-parser.js";

export type ParserAuditFindingFlag = "prompt-from-response-record" | "raw-block" | "status-leak-response";

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

const emptyCounts = (): Record<ParserAuditFindingFlag, number> => ({
  "prompt-from-response-record": 0,
  "raw-block": 0,
  "status-leak-response": 0,
});

const sampleText = (text: string) => String(text || "").replace(/\s+/g, " ").trim().slice(0, 320);

const toolForSource = (source: string) => {
  const basename = source.split("/").pop() ?? "";
  if (/^codex[-_]/i.test(basename) || /\/codex[-_]/i.test(source)) return "codex";
  if (/^claude[-_]/i.test(basename) || /\/claude[-_]/i.test(source)) return "claude";
  return "unknown";
};

const livePromptLeakLooksActionable = (content: string) => {
  return /(?:OpenAI Codex|Claude Code|gpt-[\w.-]+|bypass permissions|shift\+tab|context\)|permissions:)/i.test(content);
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
      if (block.type === "raw") {
        flags.push("raw-block");
      }
      if (block.type === "response" && STATUS_LEAK_RESPONSE_PATTERNS.some((pattern) => pattern.test(block.text))) {
        flags.push("status-leak-response");
      }
      if (
        candidate.recordType === "response" &&
        block.type === "prompt" &&
        livePromptLeakLooksActionable(candidate.content)
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
