export type PickedAttachmentKind = "image" | "audio" | "video" | "pdf" | "text" | "file";

export interface PickedAttachment {
  id: string;
  kind: PickedAttachmentKind;
  filename: string;
  mimeType: string;
  dataBase64: string;
  previewUri: string;
  sizeBytes?: number;
}

export type PickedImageAttachment = PickedAttachment;
export type ClipboardFileSource = {
  files?: ArrayLike<File> | Iterable<File> | null;
  items?:
    | ArrayLike<{ kind?: string; getAsFile?: () => File | null }>
    | Iterable<{ kind?: string; getAsFile?: () => File | null }>
    | null;
};

export async function pickAttachment(): Promise<PickedAttachment | null> {
  throw new Error("File picker is not available for this platform.");
}

export async function pickImageAttachment(): Promise<PickedImageAttachment | null> {
  return pickAttachment();
}

export async function attachmentsFromFiles(_files: Iterable<File>): Promise<PickedAttachment[]> {
  return [];
}

export async function attachmentsFromClipboardData(
  _clipboardData?: ClipboardFileSource | null,
): Promise<PickedAttachment[]> {
  return [];
}

export function clipboardDataHasFile(_clipboardData?: ClipboardFileSource | null): boolean {
  return false;
}

export async function imageAttachmentsFromFiles(
  files: Iterable<File>,
): Promise<PickedImageAttachment[]> {
  return attachmentsFromFiles(files);
}
