import React from "react";

import type { PickedImageAttachment } from "@/lib/image-picker";

export function AttachmentDropZone({
  children,
}: {
  children: (state: { dragging: boolean }) => React.ReactNode;
  disabled?: boolean;
  onDropAttachments: (attachments: PickedImageAttachment[]) => void;
  onDropRejected?: (message: string) => void;
}) {
  return <>{children({ dragging: false })}</>;
}
