import React from "react";

import type { PickedAttachment } from "@/lib/image-picker";

export function AttachmentDropZone({
  children,
}: {
  children: (state: { dragging: boolean }) => React.ReactNode;
  disabled?: boolean;
  onDropAttachments: (attachments: PickedAttachment[]) => void;
  onDropRejected?: (message: string) => void;
}) {
  return <>{children({ dragging: false })}</>;
}
