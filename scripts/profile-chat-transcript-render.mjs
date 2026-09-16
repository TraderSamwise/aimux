#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const React = require("../app/node_modules/react");

const MESSAGE_SIZES = [25, 100, 300, 600, 1000];
const DEFAULT_ITERATIONS = 80;
const WARMUP_ITERATIONS = 12;
const INVISIBLE_TEXT_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b\u200c\u200d\ufeff]/g;
const INLINE_URL_PATTERN = /\b(?:https?:\/\/|file:\/\/\/)[^\s<>"'`]+/gi;
const TERMINAL_HYPERLINK_PATTERN =
  /\x1b\]8;[^;]*;((?:https?:\/\/|file:\/\/\/)[^\x07\x1b]*)(?:\x07|\x1b\\)([\s\S]*?)\x1b\]8;;(?:\x07|\x1b\\)|\]8;[^;]*;((?:https?:\/\/|file:\/\/\/)[^\s\\\]]+)(?:\\)([\s\S]*?)\]8;;\\?/gi;
const TRAILING_URL_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}"]);
const CODE_EDIT_HEADER = /^Edited\s+\S.+\(\+\d+\s+-\d+\)\s*$/;
const CODE_EDIT_ROW = /^\s*(?:\d+|\.{2,}|…+|⋮)\s+/;
const BOX_TABLE_CHARS = /[╭╮╰╯┌┐└┘├┤┬┴┼─│═║╔╗╚╝╠╣╦╩╬]/;

const outputPath = parseOutputPath(process.argv);
const iterations = parseIterations(process.argv);

const profile = {
  generatedAt: new Date().toISOString(),
  component: "app/components/screens/AgentChatScreen.tsx AgentChatTranscript",
  method:
    "Node.js benchmark of the current eager messages.map pass plus MessageBlock text preparation. It measures JS render work, not native iOS layout.",
  iterations,
  warmupIterations: WARMUP_ITERATIONS,
  sizes: MESSAGE_SIZES.map((messageCount) => profileSize(messageCount, iterations)),
};

printProfile(profile);

if (outputPath) {
  const absoluteOutputPath = resolve(outputPath);
  mkdirSync(dirname(absoluteOutputPath), { recursive: true });
  writeFileSync(absoluteOutputPath, `${JSON.stringify(profile, null, 2)}\n`);
  console.log(`\nWrote ${absoluteOutputPath}`);
}

function parseOutputPath(args) {
  const index = args.indexOf("--output");
  if (index === -1) return null;
  const path = args[index + 1];
  if (!path) throw new Error("--output requires a path");
  return path;
}

function parseIterations(args) {
  const index = args.indexOf("--iterations");
  if (index === -1) return DEFAULT_ITERATIONS;
  const raw = args[index + 1];
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error("--iterations requires a number");
  return parsed;
}

function profileSize(messageCount, iterations) {
  const messages = buildMessages(messageCount);
  const appendedMessages = [...messages, buildMessage(messageCount)];
  const nextMessage = appendedMessages[appendedMessages.length - 1];

  const coldMount = measure(() => {
    const elements = createTranscriptElements(messages);
    const prepared = messages.map(prepareMessageBlock);
    return elements.length + prepared.length;
  }, iterations);

  const appendUpdate = measure(() => {
    const elements = createTranscriptElements(appendedMessages);
    const prepared = prepareMessageBlock(nextMessage);
    return elements.length + prepared.nodeCount;
  }, iterations);

  const draftKeystroke = measure(() => {
    const previousTranscriptProps = {
      messages,
      onContentSizeChange: stableNoop,
      onScroll: stableNoop,
    };
    const nextDraft = "typing ".repeat(4);
    const nextTranscriptProps = previousTranscriptProps;
    return nextDraft.length + (nextTranscriptProps === previousTranscriptProps ? 0 : 1);
  }, iterations);

  return { appendUpdate, coldMount, draftKeystroke, messageCount };
}

function measure(callback, iterations) {
  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) callback();
  const samples = [];
  let guard = 0;
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    guard += callback();
    samples.push(performance.now() - startedAt);
  }
  if (guard <= 0) throw new Error("profile callback returned no work");
  samples.sort((a, b) => a - b);
  return {
    maxMs: round(samples[samples.length - 1] ?? 0),
    medianMs: round(percentile(samples, 0.5)),
    minMs: round(samples[0] ?? 0),
    p95Ms: round(percentile(samples, 0.95)),
  };
}

function percentile(samples, quantile) {
  if (samples.length === 0) return 0;
  const index = Math.min(samples.length - 1, Math.ceil(samples.length * quantile) - 1);
  return samples[index] ?? 0;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function createTranscriptElements(messages) {
  if (messages.length === 0) return [React.createElement("ChatTranscriptPlaceholder")];
  return messages.map((message, index) =>
    React.createElement(
      "View",
      {
        key: message.id ?? message.clientMessageId ?? `message:${index}`,
        style: { flexShrink: 0 },
      },
      React.createElement("MessageBlock", {
        dividerWidth: 72,
        message,
        serviceEndpoint: { host: "127.0.0.1", port: 43191 },
      }),
    ),
  );
}

function prepareMessageBlock(message) {
  const role = message.role ?? "assistant";
  const isUser = role === "user";
  const displayParts = displayableMessageParts(message.parts);
  const fallbackText = hasDisplayableChatText(message.text) ? (message.text ?? "") : "";
  let nodeCount = 1;

  if (isUser && message.actor?.displayName?.trim()) nodeCount += 1;
  if (displayParts.length === 0 && !fallbackText) return { nodeCount };

  const textParts =
    displayParts.length > 0
      ? displayParts.filter((part) => part.type === "text").map((part) => part.text)
      : [fallbackText];

  for (const text of textParts) {
    for (const segment of splitMessageTextSegments(text)) {
      nodeCount += 1;
      for (const linkSegment of splitChatTextLinkSegments(segment.text)) {
        if (linkSegment.kind === "link") nodeCount += 1;
      }
    }
  }

  nodeCount += displayParts.filter((part) => part.type !== "text").length;
  return { nodeCount };
}

function displayableMessageParts(parts) {
  return (parts ?? []).filter((part) => part.type !== "text" || hasDisplayableChatText(part.text));
}

function hasDisplayableChatText(text) {
  return String(text ?? "").replace(INVISIBLE_TEXT_PATTERN, "").trim().length > 0;
}

function splitChatTextLinkSegments(text) {
  const terminalSegments = splitTerminalHyperlinkSegments(text);
  return mergeAdjacentTextSegments(
    terminalSegments.flatMap((segment) =>
      segment.kind === "link" ? [segment] : splitInlineUrlSegments(segment.text),
    ),
  );
}

function splitTerminalHyperlinkSegments(text) {
  const segments = [];
  TERMINAL_HYPERLINK_PATTERN.lastIndex = 0;
  let cursor = 0;
  let match;
  while ((match = TERMINAL_HYPERLINK_PATTERN.exec(text))) {
    if (match.index > cursor) segments.push({ kind: "text", text: text.slice(cursor, match.index) });
    const url = match[1] ?? match[3] ?? "";
    const label = cleanTerminalHyperlinkLabel(match[2] ?? match[4] ?? "", url);
    segments.push({ kind: "link", text: label, url });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments.length > 0 ? segments : [{ kind: "text", text }];
}

function cleanTerminalHyperlinkLabel(label, url) {
  const trimmed = label.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim();
  return trimmed || url;
}

function splitInlineUrlSegments(text) {
  const segments = [];
  INLINE_URL_PATTERN.lastIndex = 0;
  let cursor = 0;
  let match;
  while ((match = INLINE_URL_PATTERN.exec(text))) {
    const raw = match[0] ?? "";
    const trimmed = trimTrailingUrlPunctuation(raw);
    if (!trimmed) continue;
    const start = match.index;
    const end = start + trimmed.length;
    if (start > cursor) segments.push({ kind: "text", text: text.slice(cursor, start) });
    segments.push({ kind: "link", text: trimmed, url: trimmed });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments.length > 0 ? segments : [{ kind: "text", text }];
}

function trimTrailingUrlPunctuation(text) {
  let end = text.length;
  while (end > 0 && TRAILING_URL_PUNCTUATION.has(text[end - 1] ?? "")) end -= 1;
  return text.slice(0, end);
}

function mergeAdjacentTextSegments(segments) {
  const merged = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const previous = merged[merged.length - 1];
    if (previous?.kind === "text" && segment.kind === "text") {
      previous.text += segment.text;
      continue;
    }
    merged.push(segment);
  }
  return merged.length > 0 ? merged : [{ kind: "text", text: "" }];
}

function splitMessageTextSegments(text) {
  return splitCodeEditDiffSegments(text).flatMap((segment) =>
    segment.kind === "code-edit-diff" ? [segment] : splitMarkdownTableSegments(segment.text),
  );
}

function splitCodeEditDiffSegments(text) {
  const lines = text.split("\n");
  const segments = [];
  let cursor = 0;
  const lineStarts = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const lineEnd = (index) =>
    (lineStarts[index] ?? text.length) +
    (lines[index] ?? "").length +
    (index < lines.length - 1 ? 1 : 0);
  const pushText = (start, end) => {
    const value = text.slice(start, end).trim();
    if (value) segments.push({ kind: "text", text: value });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!CODE_EDIT_HEADER.test(line.trim())) continue;
    let endLine = index;
    let sawDiffRow = false;
    for (let next = index + 1; next < lines.length; next += 1) {
      const nextLine = lines[next] ?? "";
      if (nextLine.trim() === "") break;
      if (CODE_EDIT_ROW.test(nextLine)) sawDiffRow = true;
      if (!sawDiffRow) break;
      endLine = next;
    }
    if (!sawDiffRow) continue;
    const start = lineStarts[index] ?? 0;
    const end = lineEnd(endLine);
    pushText(cursor, start);
    segments.push({ kind: "code-edit-diff", text: text.slice(start, end).trimEnd() });
    cursor = end;
    index = endLine;
  }

  pushText(cursor, text.length);
  return segments.length > 0 ? segments : [{ kind: "text", text }];
}

function splitMarkdownTableSegments(text) {
  const lines = text.split("\n");
  const segments = [];
  let textLines = [];
  const flushText = () => {
    const value = textLines.join("\n").trim();
    if (value) segments.push({ kind: "text", text: value });
    textLines = [];
  };
  for (let index = 0; index < lines.length; ) {
    if (
      index + 1 < lines.length &&
      isMarkdownTableRow(lines[index] ?? "") &&
      isMarkdownTableSeparator(lines[index + 1] ?? "")
    ) {
      flushText();
      const tableLines = [lines[index] ?? "", lines[index + 1] ?? ""];
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index] ?? "")) {
        tableLines.push(lines[index] ?? "");
        index += 1;
      }
      segments.push({ kind: "table", text: tableLines.join("\n") });
      continue;
    }
    if (isTerminalBoxTableLine(lines[index] ?? "")) {
      const tableLines = [];
      while (index < lines.length && isTerminalBoxTableLine(lines[index] ?? "")) {
        tableLines.push(lines[index] ?? "");
        index += 1;
      }
      if (isTerminalBoxTableBlock(tableLines)) {
        flushText();
        segments.push({ kind: "table", text: tableLines.join("\n") });
        continue;
      }
      textLines.push(...tableLines);
      continue;
    }
    textLines.push(lines[index] ?? "");
    index += 1;
  }
  flushText();
  return segments.length > 0 ? segments : [{ kind: "text", text }];
}

function isMarkdownTableRow(line) {
  const cells = markdownTableCells(line);
  return cells.length >= 2 && cells.some((cell) => cell.length > 0);
}

function isMarkdownTableSeparator(line) {
  const cells = markdownTableCells(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function markdownTableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTerminalBoxTableLine(line) {
  const trimmed = line.trim();
  return trimmed.length >= 2 && BOX_TABLE_CHARS.test(trimmed);
}

function isTerminalBoxTableBlock(lines) {
  return lines.length >= 2 && lines.some((line) => /[─═]/.test(line)) && lines.some((line) => /[│║]/.test(line));
}

function buildMessages(count) {
  return Array.from({ length: count }, (_, index) => buildMessage(index));
}

function buildMessage(index) {
  const role = index % 5 === 0 ? "user" : "assistant";
  const text = buildMessageText(index);
  return {
    actor: role === "user" ? { displayName: "Sam", userId: "sam" } : undefined,
    id: `message-${index}`,
    parts: [{ type: "text", text }],
    role,
    text,
    ts: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  };
}

function buildMessageText(index) {
  const base = [
    `Turn ${index}: checking transcript render behaviour for an active agent session.`,
    "The answer includes enough text to wrap on an iPhone-sized viewport and exercise link parsing.",
    `Reference: https://aimux.example.test/session/${index}.`,
  ];
  if (index % 11 === 0) {
    base.push("| file | status | notes |");
    base.push("| --- | --- | --- |");
    base.push(`| app/components/screens/AgentChatScreen.tsx | observed | row ${index} |`);
  }
  if (index % 17 === 0) {
    base.push(`Edited app/components/screens/AgentChatScreen.tsx (+${index + 3} -2)`);
    base.push("  1201 const stableProps = useMemo(() => props, [props]);");
    base.push("  1202 const transcript = messages.map(renderMessage);");
  }
  if (index % 23 === 0) {
    base.push("╭──────────────╮");
    base.push("│ terminal box │");
    base.push("╰──────────────╯");
  }
  return base.join("\n");
}

function stableNoop() {}

function printProfile(result) {
  console.log("# Agent chat transcript render profile\n");
  console.log(result.method);
  console.log(`Iterations per case: ${result.iterations}; warmup: ${result.warmupIterations}\n`);
  console.log("| messages | cold mount median/p95 ms | append update median/p95 ms | draft keystroke median/p95 ms |");
  console.log("| ---: | ---: | ---: | ---: |");
  for (const row of result.sizes) {
    console.log(
      `| ${row.messageCount} | ${row.coldMount.medianMs}/${row.coldMount.p95Ms} | ${row.appendUpdate.medianMs}/${row.appendUpdate.p95Ms} | ${row.draftKeystroke.medianMs}/${row.draftKeystroke.p95Ms} |`,
    );
  }
}
