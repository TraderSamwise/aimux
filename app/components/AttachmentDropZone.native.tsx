import React, { useCallback } from "react";
import { Platform, UIManager, requireNativeComponent, View, type ViewProps } from "react-native";

import type { PickedAttachment } from "@/lib/image-picker";

type NativeDroppedImage = {
  dataBase64: string;
  filename: string;
  mimeType: string;
  sizeBytes?: number;
};

type NativeDropEvent = {
  nativeEvent: {
    images?: NativeDroppedImage[];
  };
};

type NativeDropViewProps = ViewProps & {
  onDropImages?: (event: NativeDropEvent) => void;
};

const hasNativeDropView =
  Platform.OS === "ios" && UIManager.getViewManagerConfig("AimuxAttachmentDropView") != null;

const NativeDropView = hasNativeDropView
  ? requireNativeComponent<NativeDropViewProps>("AimuxAttachmentDropView")
  : View;

function localId(): string {
  return `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function toPickedAttachment(image: NativeDroppedImage): PickedAttachment {
  return {
    id: localId(),
    kind: "image",
    filename: image.filename,
    mimeType: image.mimeType,
    dataBase64: image.dataBase64,
    previewUri: `data:${image.mimeType};base64,${image.dataBase64}`,
    sizeBytes: image.sizeBytes,
  };
}

export function AttachmentDropZone({
  children,
  disabled,
  onDropAttachments,
}: {
  children: (state: { dragging: boolean }) => React.ReactNode;
  disabled?: boolean;
  onDropAttachments: (attachments: PickedAttachment[]) => void;
  onDropRejected?: (message: string) => void;
}) {
  const handleDropImages = useCallback(
    (event: NativeDropEvent) => {
      if (disabled) return;
      const images = event.nativeEvent.images ?? [];
      if (images.length > 0) onDropAttachments(images.map(toPickedAttachment));
    },
    [disabled, onDropAttachments],
  );

  if (!hasNativeDropView) {
    return <>{children({ dragging: false })}</>;
  }

  return (
    <NativeDropView onDropImages={handleDropImages} style={{ display: "flex" }}>
      {children({ dragging: false })}
    </NativeDropView>
  );
}
