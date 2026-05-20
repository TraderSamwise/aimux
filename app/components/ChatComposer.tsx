import React, { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useSetAtom } from "jotai";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { addPendingAtom, updatePendingAtom } from "@/stores/chat";
import { sendAgentInput, uploadAttachmentBase64 } from "@/lib/api";
import type { AgentInputPart, HistoryPart } from "@/lib/events";
import { pickImages } from "@/lib/image-picker";
import type { ServiceEndpoint } from "@/lib/daemon-url";

interface Props {
  serviceEndpoint: ServiceEndpoint;
  sessionId: string;
  token: string | null;
}

interface DraftImage {
  attachmentId: string;
  filename: string;
  mimeType?: string;
  contentUrl?: string;
}

function uuid(): string {
  // crypto.randomUUID is available on modern web + Hermes on RN 0.74+
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback: timestamp + random.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function ChatComposer({ serviceEndpoint, sessionId, token }: Props) {
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<DraftImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addPending = useSetAtom(addPendingAtom);
  const updatePending = useSetAtom(updatePendingAtom);

  async function handleAttach() {
    setError(null);
    const picked = await pickImages();
    if (!picked || picked.length === 0) return;
    setUploading(true);
    try {
      const uploaded: DraftImage[] = [];
      for (const image of picked) {
        const res = await uploadAttachmentBase64(
          serviceEndpoint,
          {
            filename: image.filename,
            mimeType: image.mimeType,
            contentBase64: image.contentBase64,
          },
          { token },
        );
        uploaded.push({
          attachmentId: res.attachment.id,
          filename: image.filename,
          mimeType: image.mimeType,
          contentUrl: res.attachment.contentUrl,
        });
      }
      setDraftImages((prev) => [...prev, ...uploaded]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  function removeDraftImage(attachmentId: string) {
    setDraftImages((prev) => prev.filter((img) => img.attachmentId !== attachmentId));
  }

  async function handleSend() {
    const trimmed = draft.trim();
    if (!trimmed && draftImages.length === 0) return;
    if (sending) return;

    setError(null);
    setSending(true);

    const clientMessageId = uuid();
    const sendParts: AgentInputPart[] = [];
    const historyParts: HistoryPart[] = [];
    if (trimmed) {
      sendParts.push({ type: "text", text: trimmed });
      historyParts.push({ type: "text", text: trimmed });
    }
    for (const img of draftImages) {
      sendParts.push({ type: "image", attachmentId: img.attachmentId, alt: img.filename });
      historyParts.push({
        type: "image",
        attachmentId: img.attachmentId,
        filename: img.filename,
        mimeType: img.mimeType,
        contentUrl: img.contentUrl,
      });
    }

    addPending({
      sessionId,
      pending: {
        clientMessageId,
        parts: historyParts,
        ts: new Date().toISOString(),
        deliveryState: "sending",
      },
    });

    try {
      const result = await sendAgentInput(
        serviceEndpoint,
        { sessionId, data: "", parts: sendParts, clientMessageId, submit: true },
        { token },
      );
      if (!result.accepted) {
        const msg = result.error ?? "The agent input operation failed.";
        updatePending({
          sessionId,
          clientMessageId,
          patch: { deliveryState: "failed", deliveryError: msg },
        });
        setError(msg);
        return;
      }
      updatePending({
        sessionId,
        clientMessageId,
        patch: { deliveryState: (result.operation?.state as "submitted") ?? "submitted" },
      });
      setDraft("");
      setDraftImages([]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      updatePending({
        sessionId,
        clientMessageId,
        patch: { deliveryState: "failed", deliveryError: msg },
      });
      setError(msg);
    } finally {
      setSending(false);
    }
  }

  return (
    <View className="border-t border-border bg-background p-3">
      {draftImages.length > 0 ? (
        <View className="flex-row flex-wrap gap-2 mb-2">
          {draftImages.map((img) => (
            <Pressable
              key={img.attachmentId}
              onPress={() => removeDraftImage(img.attachmentId)}
              className="rounded-md bg-muted px-2 py-1"
            >
              <Text className="text-xs text-foreground">📎 {img.filename} ×</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {error ? <Text className="text-xs text-destructive mb-2">{error}</Text> : null}
      <View className="flex-row gap-2 items-end">
        <TextInput
          className="flex-1 min-h-[44px] max-h-[160px] rounded-lg border border-border bg-background px-3 py-2 text-foreground"
          placeholder="Message the agent…"
          placeholderTextColor="#9ca3af"
          value={draft}
          onChangeText={setDraft}
          multiline
          editable={!sending}
        />
        <Button
          variant="outline"
          size="default"
          label={uploading ? "…" : "📎"}
          onPress={handleAttach}
          disabled={uploading || sending}
        />
        <Button
          label={sending ? "Sending…" : "Send"}
          onPress={handleSend}
          disabled={sending || (!draft.trim() && draftImages.length === 0)}
        />
      </View>
    </View>
  );
}
