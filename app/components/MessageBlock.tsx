import React from "react";
import { Image, View } from "react-native";
import { Text } from "@/components/ui/text";
import type { ChatMessage, HistoryImagePart } from "@/lib/events";
import { getServiceUrl, type ServiceEndpoint } from "@/lib/daemon-url";
import { env } from "@/lib/env";

interface Props {
  message: ChatMessage;
  serviceEndpoint: ServiceEndpoint;
}

export function resolveImageUrl(part: HistoryImagePart, endpoint: ServiceEndpoint): string | null {
  if (!part.contentUrl) return null;
  if (part.contentUrl.startsWith("http://") || part.contentUrl.startsWith("https://")) {
    return part.contentUrl;
  }
  if (env.AIMUX_CONNECTION_MODE === "relay") return null;
  return `${getServiceUrl(endpoint)}${part.contentUrl}`;
}

export function MessageBlock({ message, serviceEndpoint }: Props) {
  const role = message.role ?? "assistant";
  const isUser = role === "user";

  return (
    <View
      className={
        isUser
          ? "self-end max-w-[80%] rounded-lg bg-primary px-3 py-2 my-1"
          : "self-start max-w-[90%] rounded-lg bg-secondary px-3 py-2 my-1"
      }
    >
      {message.deliveryState === "failed" ? (
        <Text className="text-xs text-destructive mb-1">
          {message.deliveryError ?? "Failed to deliver"}
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
          const url = resolveImageUrl(part, serviceEndpoint);
          if (!url) {
            return (
              <Text key={idx} className="text-xs text-muted-foreground">
                [image]
              </Text>
            );
          }
          return (
            <Image
              key={idx}
              source={{ uri: url }}
              style={{ width: 200, height: 200, borderRadius: 6, marginTop: 4 }}
              resizeMode="cover"
            />
          );
        })
      ) : (
        <Text className={isUser ? "text-primary-foreground" : "text-secondary-foreground"}>
          {message.text ?? ""}
        </Text>
      )}
      {message.deliveryState === "sending" ? (
        <Text className="text-xs text-muted-foreground mt-1">Sending…</Text>
      ) : null}
    </View>
  );
}
