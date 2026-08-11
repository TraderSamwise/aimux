import React, { useCallback, useState } from "react";

export function AttachmentDropZone({
  children,
  disabled,
  onDropFiles,
}: {
  children: (state: { dragging: boolean }) => React.ReactNode;
  disabled?: boolean;
  onDropFiles: (files: File[]) => void;
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
    (event: React.DragEvent<HTMLDivElement>) => {
      if (disabled || !hasImage(event)) return;
      event.preventDefault();
      setDragging(false);
      onDropFiles(Array.from(event.dataTransfer.files ?? []));
    },
    [disabled, hasImage, onDropFiles],
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
