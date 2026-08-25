export interface AgentOutputSseTextHandler {
  pushChunkText(chunk: string): void;
}

export function createAgentOutputSseTextHandler(
  sessionId: string,
  writeText: (text: string) => void,
): AgentOutputSseTextHandler {
  let buffer = "";
  let lastOutput = "";
  let wroteTailNotice = false;

  const overlapSuffixPrefixLength = (previous: string, next: string): number => {
    const max = Math.min(previous.length, next.length);
    for (let length = max; length > 0; length -= 1) {
      if (previous.endsWith(next.slice(0, length))) return length;
    }
    return 0;
  };

  const flushEventBlock = (block: string) => {
    const lines = block.split("\n");
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    if (eventName === "ready") return;
    if (eventName === "error") {
      const payload = dataLines.length > 0 ? JSON.parse(dataLines.join("\n")) : {};
      throw new Error(payload?.error || `stream error for ${sessionId}`);
    }
    if (eventName !== "output" || dataLines.length === 0) return;
    const payload = JSON.parse(dataLines.join("\n")) as {
      output?: string;
      captureLineLimit?: number;
      outputTailOnly?: boolean;
      outputStartLineClamped?: boolean;
    };
    if (typeof payload.output !== "string") return;
    const nextOutput = payload.output;
    if ((payload.outputTailOnly || payload.outputStartLineClamped) && !wroteTailNotice) {
      const limit = payload.captureLineLimit && payload.captureLineLimit > 0 ? payload.captureLineLimit : "bounded";
      writeText(`[aimux showing last ${limit} lines]\n`);
      wroteTailNotice = true;
    }
    const overlap =
      lastOutput && !nextOutput.startsWith(lastOutput) ? overlapSuffixPrefixLength(lastOutput, nextOutput) : 0;
    const renderText = nextOutput.startsWith(lastOutput)
      ? nextOutput.slice(lastOutput.length)
      : overlap > 0
        ? nextOutput.slice(overlap)
        : `${lastOutput ? "\n[aimux stream resync]\n" : ""}${nextOutput}`;
    lastOutput = nextOutput;
    if (!renderText) return;
    writeText(renderText);
    if (renderText.length > 0 && !renderText.endsWith("\n")) {
      writeText("\n");
    }
  };

  return {
    pushChunkText(chunk: string) {
      buffer += chunk;
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary).replace(/\r/g, "");
        buffer = buffer.slice(boundary + 2);
        if (block && !block.startsWith(":")) {
          flushEventBlock(block);
        }
        boundary = buffer.indexOf("\n\n");
      }
    },
  };
}
