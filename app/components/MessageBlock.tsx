import React from "react";
import { Image, View } from "react-native";
import { Text } from "@/components/ui/text";
import type { ChatMessage, HistoryImagePart, HistoryImageReferencePart } from "@/lib/events";
import { getRelayServiceUrl, getServiceUrl, type ServiceEndpoint } from "@/lib/daemon-url";
import { env } from "@/lib/env";

interface Props {
  message: ChatMessage;
  serviceEndpoint: ServiceEndpoint;
}

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

export function MessageBlock({ message, serviceEndpoint }: Props) {
  const role = message.role ?? "assistant";
  const isUser = role === "user";
  const speakerLabel = isUser ? messageSpeakerLabel(message) : null;

  return (
    <View
      className={
        isUser
          ? "self-end max-w-[80%] rounded-lg bg-primary px-3 py-2 my-1"
          : "self-start max-w-[90%] rounded-lg bg-secondary px-3 py-2 my-1"
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
            return (
              <Text
                key={idx}
                className={isUser ? "text-primary-foreground" : "text-secondary-foreground"}
              >
                {part.text}
              </Text>
            );
          }
          return (
            <ImageReferenceToken key={idx} part={part} endpoint={serviceEndpoint} isUser={isUser} />
          );
        })
      ) : (
        <Text className={isUser ? "text-primary-foreground" : "text-secondary-foreground"}>
          {message.text ?? ""}
        </Text>
      )}
    </View>
  );
}
