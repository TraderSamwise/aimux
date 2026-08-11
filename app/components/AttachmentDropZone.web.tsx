import React, { useCallback, useState } from "react";

import { imageAttachmentsFromFiles, type PickedImageAttachment } from "@/lib/image-picker";

export function AttachmentDropZone({
  children,
  disabled,
  onDropAttachments,
  onDropRejected,
}: {
  children: (state: { dragging: boolean }) => React.ReactNode;
  disabled?: boolean;
  onDropAttachments: (attachments: PickedImageAttachment[]) => void;
  onDropRejected?: (message: string) => void;
}) {
  const [dragging, setDragging] = useState(false);

  const hasImage = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const items = Array.from(event.dataTransfer.items ?? []);
    if (items.length > 0) {
      return items.some((item) => item.kind === "file" && item.type.startsWith("image/"));
    }
    return Array.from(event.dataTransfer.files ?? []).some((file) =>
      file.type.startsWith("image/"),
    );
  }, []);

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (disabled || !hasImage(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDragging(true);
    },
    [disabled, hasImage],
  );

  const handleDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      if (disabled || !hasImage(event)) return;
      event.preventDefault();
      setDragging(false);
      const files = Array.from(event.dataTransfer.files ?? []);
      try {
        const attachments = await imageAttachmentsFromFiles(files);
        if (files.length > 0 && attachments.length === 0) {
          onDropRejected?.("Drop image files only.");
          return;
        }
        onDropAttachments(attachments);
      } catch (err) {
        onDropRejected?.(err instanceof Error ? err.message : String(err));
      }
    },
    [disabled, hasImage, onDropAttachments, onDropRejected],
  );

  return (
    <div
      onDragEnter={handleDragOver}
      onDragLeave={() => setDragging(false)}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{ display: "flex", flexDirection: "column" }}
    >
      {children({ dragging })}
    </div>
  );
}
