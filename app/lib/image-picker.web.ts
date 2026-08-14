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
  return true;
}

export function isAcceptedImageFile(file: Pick<File, "type">): boolean {
  return file.type.startsWith("image/");
}

export async function attachmentsFromFiles(files: Iterable<File>): Promise<PickedAttachment[]> {
  return Promise.all(Array.from(files).filter(isAcceptedAttachmentFile).map(attachmentFromFile));
}

export async function imageAttachmentsFromFiles(
  files: Iterable<File>,
): Promise<PickedImageAttachment[]> {
  return attachmentsFromFiles(files);
}

async function attachmentFromFile(file: File): Promise<PickedAttachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(",");
  if (comma === -1) throw new Error("Could not read file data.");
  const mimeType = file.type || dataUrl.slice(5, comma).split(";")[0] || "application/octet-stream";

  return {
    id: localId(),
    kind: kindFromMimeType(mimeType),
    filename: file.name || "attachment",
    mimeType,
    dataBase64: dataUrl.slice(comma + 1),
    previewUri: dataUrl,
    sizeBytes: file.size,
  };
}
