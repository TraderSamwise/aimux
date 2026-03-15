import { createWriteStream, type WriteStream } from "node:fs";

let stream: WriteStream | null = null;

function ensureStream(): WriteStream {
  if (!stream) {
    stream = createWriteStream("/tmp/aimux-debug.log", { flags: "a" });
  }
  return stream;
}

export function debug(msg: string, category?: string): void {
  const s = ensureStream();
  const ts = new Date().toISOString().slice(11, 23);
  const prefix = category ? `[${ts}] [${category}]` : `[${ts}]`;
  s.write(`${prefix} ${msg}\n`);
}

export function debugContext(action: string, file: string, sizeBytes: number): void {
  const sizeKB = (sizeBytes / 1024).toFixed(1);
  const estTokens = Math.round(sizeBytes / 4);
  debug(`${action} ${file} (${sizeKB}KB, ~${estTokens} tokens)`, "context");
}

export function debugCompact(sessionCount: number, totalTurns: number): void {
  debug(`compacting ${totalTurns} turns across ${sessionCount} sessions`, "compact");
}

export function debugPreamble(tool: string, sizeBytes: number): void {
  const sizeKB = (sizeBytes / 1024).toFixed(1);
  const estTokens = Math.round(sizeBytes / 4);
  debug(`preamble for ${tool}: ${sizeKB}KB, ~${estTokens} tokens overhead`, "preamble");
}

export function debugTurn(sessionId: string, type: string, contentLen: number): void {
  debug(`${type} from ${sessionId} (${contentLen} chars)`, "turn");
}

export function debugGit(filesChanged: number, diffLen: number): void {
  debug(`git: ${filesChanged} files changed, diff ${diffLen} chars`, "git");
}

export function closeDebug(): void {
  if (stream) {
    debug("--- aimux session ended ---");
    stream.end();
    stream = null;
  }
}
