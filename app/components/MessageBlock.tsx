import React from "react";
import {
  Image,
  Platform,
  ScrollView,
  Text as RNText,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { useAtomValue } from "jotai";
import { Text } from "@/components/ui/text";
import type {
  ChatMessage,
  HistoryAttachmentReferencePart,
  HistoryImagePart,
  HistoryImageReferencePart,
  HistoryTextSpan,
} from "@/lib/events";
import { getRelayServiceUrl, getServiceUrl, type ServiceEndpoint } from "@/lib/daemon-url";
import { env } from "@/lib/env";
import { formatPlainTextForDisplay, formatRichTextSpansForDisplay } from "@/lib/terminal-output";
import { chatRichTerminalColorsAtom } from "@/stores/settings";

interface Props {
  message: ChatMessage;
  serviceEndpoint: ServiceEndpoint;
  dividerWidth?: number;
}

const MESSAGE_BASE_STYLE: ViewStyle = {
  flexShrink: 1,
  overflow: "hidden",
};
const MESSAGE_ASSISTANT_STYLE: ViewStyle = {
  ...MESSAGE_BASE_STYLE,
  maxWidth: "90%",
};
const MESSAGE_USER_STYLE: ViewStyle = {
  ...MESSAGE_BASE_STYLE,
  maxWidth: "80%",
};
const MESSAGE_TEXT_STYLE: TextStyle = {
  flexShrink: 1,
  flexWrap: "wrap",
  ...(Platform.OS === "web" ? { fontSize: 15, lineHeight: 21 } : {}),
  maxWidth: "100%",
};

export type TextSegment = { kind: "text" | "table"; text: string };
type TextSegmentWithRange = TextSegment & { end: number; start: number };
const BOX_TABLE_CHARS = /[╭╮╰╯┌┐└┘├┤┬┴┼─│═║╔╗╚╝╠╣╦╩╬]/;

export function resolveImageUrl(
  part: HistoryImagePart | HistoryImageReferencePart | HistoryAttachmentReferencePart,
  endpoint: ServiceEndpoint,
): string | null {
  const contentUrl =
    env.AIMUX_CONNECTION_MODE === "relay" && part.hostedContentUrl
      ? part.hostedContentUrl
      : (part.contentUrl ?? part.hostedContentUrl);
  if (!contentUrl) return null;
  if (contentUrl.startsWith("http://") || contentUrl.startsWith("https://")) {
    return contentUrl;
  }
  const path = contentUrl.startsWith("/") ? contentUrl : `/${contentUrl}`;
  if (env.AIMUX_CONNECTION_MODE === "relay") return getRelayServiceUrl(endpoint, path);
  return `${getServiceUrl(endpoint)}${path}`;
}

export const resolveAttachmentUrl = resolveImageUrl;

export function messageSpeakerLabel(message: Pick<ChatMessage, "actor">): string | null {
  const name = message.actor?.displayName?.trim().replace(/\s+/g, " ");
  return name || null;
}

function imagePartLabel(part: HistoryImagePart | HistoryImageReferencePart): string {
  if ("label" in part && part.label.trim()) return part.label;
  return "[image]";
}

function attachmentPartLabel(part: HistoryAttachmentReferencePart): string {
  if (part.label.trim()) return part.label;
  return "[file]";
}

function attachmentPreviewKind(part: HistoryAttachmentReferencePart): string {
  const mimeType = part.mimeType ?? "";
  if (part.kind === "image" || mimeType.startsWith("image/")) return "image";
  if (part.kind === "audio" || mimeType.startsWith("audio/")) return "audio";
  if (part.kind === "video" || mimeType.startsWith("video/")) return "video";
  if (part.kind === "pdf" || mimeType === "application/pdf") return "pdf";
  if (part.kind === "text" || mimeType.startsWith("text/") || mimeType === "application/json") {
    return "text";
  }
  return "file";
}

function spanText(spans: readonly HistoryTextSpan[]): string {
  return spans.map((span) => span.text).join("");
}

function isMarkdownTableRow(line: string): boolean {
  const cells = markdownTableCells(line);
  return cells.length >= 2 && cells.some((cell) => cell.length > 0);
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = markdownTableCells(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function markdownTableCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function splitMarkdownTableSegments(text: string): TextSegment[] {
  return splitMarkdownTableSegmentsWithRanges(text).map(({ kind, text }) => ({ kind, text }));
}

function splitMarkdownTableSegmentsWithRanges(text: string): TextSegmentWithRange[] {
  const lines = text.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const segments: TextSegmentWithRange[] = [];
  let textStart = 0;
  let textEnd = 0;
  const flushText = () => {
    let start = textStart;
    let end = textEnd;
    while (start < end && text[start] === "\n") start += 1;
    while (end > start && /\s/.test(text[end - 1] ?? "")) end -= 1;
    if (start < end) segments.push({ kind: "text", text: text.slice(start, end), start, end });
  };

  for (let index = 0; index < lines.length; ) {
    if (
      index + 1 < lines.length &&
      isMarkdownTableRow(lines[index] ?? "") &&
      isMarkdownTableSeparator(lines[index + 1] ?? "")
    ) {
      flushText();
      const tableStart = lineStarts[index] ?? 0;
      const tableLines = [lines[index] ?? "", lines[index + 1] ?? ""];
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index] ?? "")) {
        tableLines.push(lines[index] ?? "");
        index += 1;
      }
      const tableText = tableLines.join("\n");
      segments.push({
        kind: "table",
        text: tableText,
        start: tableStart,
        end: tableStart + tableText.length,
      });
      textStart = lineStarts[index] ?? text.length;
      textEnd = textStart;
      continue;
    }
    if (isTerminalBoxTableLine(lines[index] ?? "")) {
      const tableStartIndex = index;
      const tableStart = lineStarts[index] ?? 0;
      const tableLines: string[] = [];
      while (index < lines.length && isTerminalBoxTableLine(lines[index] ?? "")) {
        tableLines.push(lines[index] ?? "");
        index += 1;
      }
      if (tableLines.length >= 2) {
        flushText();
        const tableText = tableLines.join("\n");
        segments.push({
          kind: "table",
          text: tableText,
          start: tableStart,
          end: tableStart + tableText.length,
        });
        textStart = lineStarts[index] ?? text.length;
        textEnd = textStart;
        continue;
      }
      index = tableStartIndex;
    }
    if (textStart === textEnd) textStart = lineStarts[index] ?? textEnd;
    textEnd =
      (lineStarts[index] ?? 0) + (lines[index] ?? "").length + (index < lines.length - 1 ? 1 : 0);
    index += 1;
  }

  flushText();
  return segments;
}

function isTerminalBoxTableLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 2) return false;
  return BOX_TABLE_CHARS.test(trimmed);
}

export function canRenderRichText(
  text: string,
  spans: readonly HistoryTextSpan[] | undefined,
): spans is readonly HistoryTextSpan[] {
  return Boolean(spans?.length) && spanText(spans ?? []) === text;
}

export function shouldRenderRichTerminalText(input: {
  isUser: boolean;
  enabled: boolean;
  text: string;
  spans: readonly HistoryTextSpan[] | undefined;
}): input is {
  isUser: false;
  enabled: true;
  text: string;
  spans: readonly HistoryTextSpan[];
} {
  return !input.isUser && input.enabled && canRenderRichText(input.text, input.spans);
}

export function styleForRichTextSpan(span: HistoryTextSpan): TextStyle {
  const marks = new Set(span.marks ?? []);
  return {
    ...(span.foreground?.model === "rgb" ? { color: span.foreground.value } : {}),
    ...(span.background?.model === "rgb" ? { backgroundColor: span.background.value } : {}),
    ...(marks.has("bold") ? { fontWeight: "700" as const } : {}),
    ...(marks.has("italic") ? { fontStyle: "italic" as const } : {}),
    ...(marks.has("dim") ? { opacity: 0.65 } : {}),
    ...(marks.has("underline") && marks.has("strike")
      ? { textDecorationLine: "underline line-through" as const }
      : marks.has("underline")
        ? { textDecorationLine: "underline" as const }
        : marks.has("strike")
          ? { textDecorationLine: "line-through" as const }
          : {}),
  };
}

function RichText({
  spans,
  className,
  dividerWidth,
  textStyle,
}: {
  spans: readonly HistoryTextSpan[];
  className: string;
  dividerWidth?: number;
  textStyle: TextStyle;
}) {
  const displaySpans = React.useMemo(
    () => formatRichTextSpansForDisplay(spans, { dividerWidth }),
    [dividerWidth, spans],
  );
  return (
    <Text className={className} style={textStyle}>
      {displaySpans.map((span, index) => (
        <RNText key={index} style={styleForRichTextSpan(span)}>
          {span.text}
        </RNText>
      ))}
    </Text>
  );
}

function MarkdownTableText({ className, text }: { className: string; text: string }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} className="my-1 max-w-full">
      <Text
        className={`${className} font-mono`}
        style={[MESSAGE_TEXT_STYLE, { flexWrap: "nowrap" }]}
      >
        {text}
      </Text>
    </ScrollView>
  );
}

function RichTextPart({
  className,
  dividerWidth,
  spans,
  text,
}: {
  className: string;
  dividerWidth?: number;
  spans: readonly HistoryTextSpan[];
  text: string;
}) {
  const segments = React.useMemo(() => splitMarkdownTableSegmentsWithRanges(text), [text]);
  if (segments.length === 1 && segments[0]?.kind === "text") {
    return (
      <RichText
        className={className}
        dividerWidth={dividerWidth}
        spans={spans}
        textStyle={MESSAGE_TEXT_STYLE}
      />
    );
  }

  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "table" ? (
          <MarkdownTableText key={index} className={className} text={segment.text} />
        ) : (
          <RichText
            key={index}
            className={className}
            dividerWidth={dividerWidth}
            spans={sliceRichTextSpans(spans, segment.start, segment.end)}
            textStyle={MESSAGE_TEXT_STYLE}
          />
        ),
      )}
    </>
  );
}

function sliceRichTextSpans(
  spans: readonly HistoryTextSpan[],
  start: number,
  end: number,
): HistoryTextSpan[] {
  const sliced: HistoryTextSpan[] = [];
  let cursor = 0;
  for (const span of spans) {
    const spanStart = cursor;
    const spanEnd = cursor + span.text.length;
    cursor = spanEnd;
    if (spanEnd <= start || spanStart >= end) continue;
    const from = Math.max(0, start - spanStart);
    const to = Math.min(span.text.length, end - spanStart);
    if (from < to) sliced.push({ ...span, text: span.text.slice(from, to) });
  }
  return sliced;
}

function PlainTextPart({
  className,
  dividerWidth,
  text,
}: {
  className: string;
  dividerWidth?: number;
  text: string;
}) {
  const segments = React.useMemo(() => splitMarkdownTableSegments(text), [text]);
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "table" ? (
          <MarkdownTableText key={index} className={className} text={segment.text} />
        ) : (
          <Text key={index} className={className} style={MESSAGE_TEXT_STYLE}>
            {formatPlainTextForDisplay(segment.text, { dividerWidth })}
          </Text>
        ),
      )}
    </>
  );
}

function ImageReferenceToken({
  part,
  endpoint,
  isUser,
}: {
  part: HistoryImagePart | HistoryImageReferencePart;
  endpoint: ServiceEndpoint;
  isUser: boolean;
}) {
  const label = imagePartLabel(part);
  const imageUrl = resolveImageUrl(part, endpoint);
  return (
    <View
      className={
        isUser
          ? "mt-1 self-start rounded border border-primary-foreground/35 bg-primary-foreground/15 p-2"
          : "mt-1 self-start rounded border border-border bg-background p-2"
      }
    >
      <Text
        className={
          isUser
            ? "font-mono text-xs font-semibold text-primary-foreground"
            : "font-mono text-xs font-semibold text-muted-foreground"
        }
      >
        {label}
      </Text>
      {imageUrl ? (
        <Image
          accessibilityLabel={part.filename || label}
          source={{ uri: imageUrl }}
          className="mt-2 rounded"
          resizeMode="contain"
          style={{
            width: 180,
            height: 120,
            backgroundColor: "rgba(0, 0, 0, 0.18)",
          }}
        />
      ) : null}
    </View>
  );
}

function AttachmentReferenceToken({
  part,
  endpoint,
  isUser,
}: {
  part: HistoryAttachmentReferencePart;
  endpoint: ServiceEndpoint;
  isUser: boolean;
}) {
  const label = attachmentPartLabel(part);
  const title = part.filename || label;
  const detail = [part.kind, part.mimeType].filter(Boolean).join(" · ");
  const contentUrl = resolveAttachmentUrl(part, endpoint);
  const previewKind = attachmentPreviewKind(part);
  return (
    <View
      className={
        isUser
          ? "mt-1 self-start rounded border border-primary-foreground/35 bg-primary-foreground/15 p-2"
          : "mt-1 self-start rounded border border-border bg-background p-2"
      }
    >
      <Text
        className={
          isUser
            ? "font-mono text-xs font-semibold text-primary-foreground"
            : "font-mono text-xs font-semibold text-muted-foreground"
        }
      >
        {label}
      </Text>
      <Text
        className={isUser ? "mt-1 text-sm text-primary-foreground" : "mt-1 text-sm text-foreground"}
      >
        {title}
      </Text>
      {detail ? (
        <Text
          className={
            isUser
              ? "mt-0.5 text-xs text-primary-foreground/70"
              : "mt-0.5 text-xs text-muted-foreground"
          }
        >
          {detail}
        </Text>
      ) : null}
      {contentUrl && Platform.OS === "web" ? (
        <WebAttachmentPreview kind={previewKind} url={contentUrl} title={title} />
      ) : null}
      {contentUrl && previewKind === "image" && Platform.OS !== "web" ? (
        <Image
          accessibilityLabel={title}
          source={{ uri: contentUrl }}
          className="mt-2 rounded"
          resizeMode="contain"
          style={{
            width: 180,
            height: 120,
            backgroundColor: "rgba(0, 0, 0, 0.18)",
          }}
        />
      ) : null}
    </View>
  );
}

function WebAttachmentPreview({ kind, title, url }: { kind: string; title: string; url: string }) {
  const frameStyle = {
    border: "1px solid rgba(161, 161, 170, 0.35)",
    borderRadius: 6,
    marginTop: 8,
    maxWidth: "100%",
    width: 360,
  };
  if (kind === "audio") {
    return React.createElement("audio", {
      controls: true,
      src: url,
      style: { marginTop: 8, maxWidth: "100%", width: 320 },
    });
  }
  if (kind === "video") {
    return React.createElement("video", {
      controls: true,
      src: url,
      style: {
        ...frameStyle,
        backgroundColor: "rgba(0, 0, 0, 0.18)",
        height: 220,
      },
    });
  }
  if (kind === "image") {
    return React.createElement("img", {
      alt: title,
      src: url,
      style: {
        ...frameStyle,
        backgroundColor: "rgba(0, 0, 0, 0.18)",
        height: 180,
        objectFit: "contain",
      },
    });
  }
  if (kind === "pdf" || kind === "text") {
    return React.createElement("iframe", {
      src: url,
      title,
      sandbox: "",
      style: {
        ...frameStyle,
        backgroundColor: "rgba(0, 0, 0, 0.18)",
        height: kind === "pdf" ? 240 : 180,
      },
    });
  }
  return null;
}

export const MessageBlock = React.memo(function MessageBlock({
  message,
  serviceEndpoint,
  dividerWidth,
}: Props) {
  const role = message.role ?? "assistant";
  const isUser = role === "user";
  const speakerLabel = isUser ? messageSpeakerLabel(message) : null;
  const richTerminalColors = useAtomValue(chatRichTerminalColorsAtom);

  return (
    <View
      style={isUser ? MESSAGE_USER_STYLE : MESSAGE_ASSISTANT_STYLE}
      className={
        isUser
          ? "self-end rounded-lg bg-primary px-3 py-2 my-1"
          : "self-start rounded-lg bg-secondary px-3 py-2 my-1"
      }
    >
      {speakerLabel ? (
        <Text
          className={
            isUser
              ? "text-xs font-semibold text-primary-foreground mb-1"
              : "text-xs font-semibold text-secondary-foreground mb-1"
          }
        >
          {speakerLabel}
        </Text>
      ) : null}
      {Array.isArray(message.parts) && message.parts.length > 0 ? (
        message.parts.map((part, idx) => {
          if (part.type === "text") {
            const className = isUser ? "text-primary-foreground" : "text-secondary-foreground";
            const richTextInput = {
              isUser,
              enabled: richTerminalColors,
              text: part.text,
              spans: part.spans,
            };
            if (shouldRenderRichTerminalText(richTextInput)) {
              return (
                <RichTextPart
                  key={idx}
                  className={className}
                  dividerWidth={dividerWidth}
                  spans={richTextInput.spans}
                  text={part.text}
                />
              );
            }
            return (
              <PlainTextPart
                key={idx}
                className={className}
                dividerWidth={dividerWidth}
                text={part.text}
              />
            );
          }
          if (part.type === "image" || part.type === "image_reference") {
            return (
              <ImageReferenceToken
                key={idx}
                part={part}
                endpoint={serviceEndpoint}
                isUser={isUser}
              />
            );
          }
          return (
            <AttachmentReferenceToken
              key={idx}
              part={part}
              endpoint={serviceEndpoint}
              isUser={isUser}
            />
          );
        })
      ) : (
        <PlainTextPart
          className={isUser ? "text-primary-foreground" : "text-secondary-foreground"}
          dividerWidth={dividerWidth}
          text={message.text ?? ""}
        />
      )}
    </View>
  );
});
