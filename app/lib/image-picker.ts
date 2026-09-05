export type PickedAttachmentKind = "image" | "audio" | "video" | "pdf" | "text" | "file";

export interface PickedAttachment {
  id: string;
  kind: PickedAttachmentKind;
  filename: string;
  mimeType: string;
  dataBase64?: string;
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

export interface PickAttachmentOptions {
  selectionLimit?: number;
}

export async function pickAttachment(): Promise<PickedAttachment | null> {
  throw new Error("File picker is not available for this platform.");
}

export async function pickAttachments(
  _options: PickAttachmentOptions = {},
): Promise<PickedAttachment[]> {
  const attachment = await pickAttachment();
  return attachment ? [attachment] : [];
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

export async function pickedAttachmentDataBase64(attachment: PickedAttachment): Promise<string> {
  if (attachment.dataBase64) return attachment.dataBase64;
  throw new Error("Attachment data is no longer available.");
}

export function rememberPickedAttachmentDataBase64(_id: string, _dataBase64: string) {}

export function rememberPickedAttachmentDataFile(
  _id: string,
  _uri: string,
  _options: { deleteOnRelease?: boolean } = {},
) {}

export function releasePickedAttachment(_attachment: PickedAttachment) {}
