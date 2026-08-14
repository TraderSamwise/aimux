import React, { useCallback, useState } from "react";

import { attachmentsFromFiles, type PickedAttachment } from "@/lib/image-picker";

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
