import React, { useCallback } from "react";
import { File, Paths } from "expo-file-system";
import { Platform, UIManager, requireNativeComponent, View, type ViewProps } from "react-native";

import {
  releasePickedAttachment,
  rememberPickedAttachmentDataFile,
  type PickedAttachment,
} from "@/lib/image-picker";

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

function fileExtensionForMimeType(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "jpg";
}

async function toPickedAttachment(image: NativeDroppedImage): Promise<PickedAttachment> {
  const id = localId();
  const extension = fileExtensionForMimeType(image.mimeType);
  const previewFile = new File(Paths.cache, `${id}.${extension}`);
  previewFile.write(image.dataBase64, {
    encoding: "base64",
  });
  const previewUri = previewFile.uri;
  rememberPickedAttachmentDataFile(id, previewUri, { deleteOnRelease: true });
  return {
    id,
    kind: "image",
    filename: image.filename,
    mimeType: image.mimeType,
    previewUri,
    sizeBytes: image.sizeBytes,
  };
}

async function toPickedAttachments(images: readonly NativeDroppedImage[]) {
  const attachments: PickedAttachment[] = [];
  try {
    for (const image of images) {
      attachments.push(await toPickedAttachment(image));
    }
    return attachments;
  } catch (error) {
    for (const attachment of attachments) releasePickedAttachment(attachment);
    throw error;
  }
}

export function AttachmentDropZone({
  children,
  disabled,
  onDropAttachments,
  onDropRejected,
}: {
  children: (state: { dragging: boolean }) => React.ReactNode;
  disabled?: boolean;
  onDropAttachments: (attachments: PickedAttachment[]) => void;
  onDropRejected?: (message: string) => void;
  onPasteAttachments?: (attachments: PickedAttachment[]) => void;
  onPasteRejected?: (message: string) => void;
}) {
  const handleDropImages = useCallback(
    (event: NativeDropEvent) => {
      if (disabled) return;
      const images = event.nativeEvent.images ?? [];
      if (images.length > 0) {
        void toPickedAttachments(images)
          .then(onDropAttachments)
          .catch((err) => onDropRejected?.(err instanceof Error ? err.message : String(err)));
      }
    },
    [disabled, onDropAttachments, onDropRejected],
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
