import React, { useCallback, useState } from "react";

import {
  attachmentsFromClipboardData,
  attachmentsFromFiles,
  clipboardDataHasFile,
  type PickedAttachment,
} from "@/lib/image-picker";

export function AttachmentDropZone({
  children,
  disabled,
  onDropAttachments,
  onDropRejected,
  onPasteAttachments,
  onPasteRejected,
}: {
  children: (state: { dragging: boolean }) => React.ReactNode;
  disabled?: boolean;
  onDropAttachments: (attachments: PickedAttachment[]) => void;
  onDropRejected?: (message: string) => void;
  onPasteAttachments?: (attachments: PickedAttachment[]) => void;
  onPasteRejected?: (message: string) => void;
}) {
  const [dragging, setDragging] = useState(false);

  const hasFile = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const items = Array.from(event.dataTransfer.items ?? []);
    if (items.length > 0) {
      return items.some((item) => item.kind === "file");
    }
    return Array.from(event.dataTransfer.files ?? []).length > 0;
  }, []);

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (disabled || !hasFile(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDragging(true);
    },
    [disabled, hasFile],
  );

  const handleDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      if (disabled || !hasFile(event)) return;
      event.preventDefault();
      setDragging(false);
      const files = Array.from(event.dataTransfer.files ?? []);
      try {
        const attachments = await attachmentsFromFiles(files);
        if (files.length > 0 && attachments.length === 0) {
          onDropRejected?.("Could not read dropped files.");
          return;
        }
        onDropAttachments(attachments);
      } catch (err) {
        onDropRejected?.(err instanceof Error ? err.message : String(err));
      }
    },
    [disabled, hasFile, onDropAttachments, onDropRejected],
  );

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented || disabled || !clipboardDataHasFile(event.clipboardData)) return;
      event.preventDefault();
      try {
        const attachments = await attachmentsFromClipboardData(event.clipboardData);
        if (attachments.length === 0) {
          onPasteRejected?.("Pasted files are not supported.");
          return;
        }
        onPasteAttachments?.(attachments);
      } catch (err) {
        onPasteRejected?.(err instanceof Error ? err.message : String(err));
      }
    },
    [disabled, onPasteAttachments, onPasteRejected],
  );

  return (
    <div
      onDragEnter={handleDragOver}
      onDragLeave={() => setDragging(false)}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onPaste={handlePaste}
      style={{ display: "flex", flexDirection: "column" }}
    >
      {children({ dragging })}
    </div>
  );
}
