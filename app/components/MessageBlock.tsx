import React from "react";
import {
  Image,
  Platform,
  Text as RNText,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { useAtomValue } from "jotai";
import { Text } from "@/components/ui/text";
import type {
  ChatMessage,
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
  textScale?: number;
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

export function resolveImageUrl(
  part: HistoryImagePart | HistoryImageReferencePart,
  endpoint: ServiceEndpoint,
): string | null {
  if (!part.contentUrl) return null;
  if (part.contentUrl.startsWith("http://") || part.contentUrl.startsWith("https://")) {
    return part.contentUrl;
  }
  const path = part.contentUrl.startsWith("/") ? part.contentUrl : `/${part.contentUrl}`;
  if (env.AIMUX_CONNECTION_MODE === "relay") return getRelayServiceUrl(endpoint, path);
  return `${getServiceUrl(endpoint)}${path}`;
}

export function messageSpeakerLabel(message: Pick<ChatMessage, "actor">): string | null {
  const name = message.actor?.displayName?.trim().replace(/\s+/g, " ");
  return name || null;
}

function imagePartLabel(part: HistoryImagePart | HistoryImageReferencePart): string {
  if ("label" in part && part.label.trim()) return part.label;
  return "[image]";
}

function spanText(spans: readonly HistoryTextSpan[]): string {
  return spans.map((span) => span.text).join("");
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

export const MessageBlock = React.memo(function MessageBlock({
  message,
  serviceEndpoint,
  dividerWidth,
  textScale = 1,
}: Props) {
  const role = message.role ?? "assistant";
  const isUser = role === "user";
  const speakerLabel = isUser ? messageSpeakerLabel(message) : null;
  const richTerminalColors = useAtomValue(chatRichTerminalColorsAtom);
  const formatMessageText = React.useCallback(
    (text: string) => formatPlainTextForDisplay(text, { dividerWidth }),
    [dividerWidth],
  );
  const messageTextStyle = React.useMemo<TextStyle>(
    () => ({
      ...MESSAGE_TEXT_STYLE,
      ...(Platform.OS !== "web" && textScale !== 1
        ? { fontSize: 16 * textScale, lineHeight: 22 * textScale }
        : {}),
    }),
    [textScale],
  );

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
                <RichText
                  key={idx}
                  spans={richTextInput.spans}
                  className={className}
                  dividerWidth={dividerWidth}
                  textStyle={messageTextStyle}
                />
              );
            }
            return (
              <Text key={idx} className={className} style={messageTextStyle}>
                {formatMessageText(part.text)}
              </Text>
            );
          }
          return (
            <ImageReferenceToken key={idx} part={part} endpoint={serviceEndpoint} isUser={isUser} />
          );
        })
      ) : (
        <Text
          className={isUser ? "text-primary-foreground" : "text-secondary-foreground"}
          style={messageTextStyle}
        >
          {formatMessageText(message.text ?? "")}
        </Text>
      )}
    </View>
  );
});
