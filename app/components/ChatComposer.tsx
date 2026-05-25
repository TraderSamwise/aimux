import React, { useState } from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import { useSetAtom } from "jotai";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { addPendingAtom, updatePendingAtom } from "@/stores/chat";
import { uploadAttachmentBase64 } from "@/lib/api";
import type { HistoryPart } from "@/lib/events";
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

type ComposerKeyPressEvent = {
  nativeEvent: {
    key?: string;
    shiftKey?: boolean;
  };
  preventDefault?: () => void;
};

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
    try {
      const picked = await pickImages();
      if (!picked || picked.length === 0) return;
      setUploading(true);
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

  function restoreDraftIfUntouched(text: string, images: DraftImage[]) {
    setDraft((current) => (current.length > 0 ? current : text));
    setDraftImages((current) => (current.length > 0 ? current : images));
  }

  async function handleSend() {
    const trimmed = draft.trim();
    if (!trimmed && draftImages.length === 0) return;
    if (uploading) return;
    if (sending) return;

    setError(null);
    setSending(true);

    const submittedText = trimmed;
    const submittedImages = draftImages;
    const clientMessageId = uuid();
    const historyParts: HistoryPart[] = [];
    if (submittedText) {
      historyParts.push({ type: "text", text: submittedText });
    }
    for (const img of submittedImages) {
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
    setDraft("");
    setDraftImages([]);

    try {
      const msg = "Agent messaging requires the runtime core replacement.";
      updatePending({
        sessionId,
        clientMessageId,
        patch: { deliveryState: "failed", deliveryError: msg },
      });
      setError(msg);
      restoreDraftIfUntouched(submittedText, submittedImages);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      updatePending({
        sessionId,
        clientMessageId,
        patch: { deliveryState: "failed", deliveryError: msg },
      });
      setError(msg);
      restoreDraftIfUntouched(submittedText, submittedImages);
    } finally {
      setSending(false);
    }
  }

  function handleComposerKeyPress(event: ComposerKeyPressEvent) {
    if (Platform.OS !== "web") return;
    if (event.nativeEvent.key !== "Enter" || event.nativeEvent.shiftKey) return;
    event.preventDefault?.();
    void handleSend();
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
          onKeyPress={handleComposerKeyPress}
          multiline
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
          disabled={sending || uploading || (!draft.trim() && draftImages.length === 0)}
        />
      </View>
    </View>
  );
}
