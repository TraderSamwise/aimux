import React from "react";

export function AttachmentDropZone({
  children,
}: {
  children: (state: { dragging: boolean }) => React.ReactNode;
  disabled?: boolean;
  onDropFiles: (files: File[]) => void;
}) {
  return <>{children({ dragging: false })}</>;
}
