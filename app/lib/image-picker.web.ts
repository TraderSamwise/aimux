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

function localId(): string {
  return `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function kindFromMimeType(mimeType: string): PickedAttachmentKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("text/") || mimeType === "application/json") return "text";
  return "file";
}

export async function pickAttachment(): Promise<PickedAttachment | null> {
  if (typeof document === "undefined") return null;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";

  const file = await new Promise<File | null>((resolve) => {
    const cleanup = () => {
      input.removeEventListener("change", handleChange);
      input.removeEventListener("cancel", handleCancel);
    };
    const finish = (file: File | null) => {
      cleanup();
      resolve(file);
    };
    const handleChange = () => finish(input.files?.[0] ?? null);
    const handleCancel = () => finish(null);
    input.addEventListener("change", handleChange);
    input.addEventListener("cancel", handleCancel);
    input.click();
  });
  if (!file) return null;

  return attachmentFromFile(file);
}

export async function pickImageAttachment(): Promise<PickedImageAttachment | null> {
  return pickAttachment();
}

export function isAcceptedAttachmentFile(_file: Pick<File, "type">): boolean {
  return isAcceptedImageFile(_file);
}

export function isAcceptedImageFile(file: Pick<File, "type">): boolean {
  return file.type.startsWith("image/");
}

export async function attachmentsFromFiles(files: Iterable<File>): Promise<PickedAttachment[]> {
  return Promise.all(Array.from(files).filter(isAcceptedAttachmentFile).map(attachmentFromFile));
}

export type ClipboardFileSource = {
  files?: ArrayLike<File> | Iterable<File> | null;
  items?:
    | ArrayLike<{ kind?: string; getAsFile?: () => File | null }>
    | Iterable<{ kind?: string; getAsFile?: () => File | null }>
    | null;
};

export function clipboardDataHasFile(
  clipboardData: ClipboardFileSource | null | undefined,
): boolean {
  if (!clipboardData) return false;
  if (Array.from(clipboardData.files ?? []).length > 0) return true;
  return Array.from(clipboardData.items ?? []).some((item) => item.kind === "file");
}

export async function attachmentsFromClipboardData(
  clipboardData: ClipboardFileSource | null | undefined,
): Promise<PickedAttachment[]> {
  if (!clipboardData) return [];
  const files = Array.from(clipboardData.files ?? []);
  if (files.length > 0) return attachmentsFromFiles(files);

  const itemFiles = Array.from(clipboardData.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile?.() ?? null)
    .filter((file): file is File => file !== null);
  return attachmentsFromFiles(itemFiles);
}

export async function imageAttachmentsFromFiles(
  files: Iterable<File>,
): Promise<PickedImageAttachment[]> {
  return Promise.all(Array.from(files).filter(isAcceptedImageFile).map(attachmentFromFile));
}

async function attachmentFromFile(file: File): Promise<PickedAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
  }
  const mimeType = file.type || "application/octet-stream";
  const dataBase64 = btoa(binary);

  return {
    id: localId(),
    kind: kindFromMimeType(mimeType),
    filename: file.name || "attachment",
    mimeType,
    dataBase64,
    previewUri: `data:${mimeType};base64,${dataBase64}`,
    sizeBytes: file.size,
  };
}
