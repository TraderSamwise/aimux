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
export interface PickAttachmentOptions {
  selectionLimit?: number;
}

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
  return (await pickAttachments({ selectionLimit: 1 }))[0] ?? null;
}

export async function pickAttachments(
  options: PickAttachmentOptions = {},
): Promise<PickedAttachment[]> {
  if (typeof document === "undefined") return [];
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;

  const files = await new Promise<File[]>((resolve) => {
    const cleanup = () => {
      input.removeEventListener("change", handleChange);
      input.removeEventListener("cancel", handleCancel);
    };
    const finish = (files: File[]) => {
      cleanup();
      resolve(files);
    };
    const handleChange = () => finish(Array.from(input.files ?? []));
    const handleCancel = () => finish([]);
    input.addEventListener("change", handleChange);
    input.addEventListener("cancel", handleCancel);
    input.click();
  });
  if (files.length === 0) return [];

  const selectionLimit = Math.max(0, Math.floor(options.selectionLimit ?? 0));
  const selected = selectionLimit > 0 ? files.slice(0, selectionLimit) : files;
  return Promise.all(selected.filter(isAcceptedAttachmentFile).map(attachmentFromFile));
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
  const mimeType = file.type || "application/octet-stream";
  const id = localId();
  rememberPickedAttachmentDataLoader(id, async () => {
    const dataUrl = await readFileAsDataUrl(file, mimeType);
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  });

  return {
    id,
    kind: kindFromMimeType(mimeType),
    filename: file.name || "attachment",
    mimeType,
    previewUri:
      typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(file)
        : await readFileAsDataUrl(file, mimeType),
    sizeBytes: file.size,
  };
}

type AttachmentDataLoader = () => Promise<string>;
const attachmentDataLoaders = new Map<string, AttachmentDataLoader>();

function rememberPickedAttachmentDataLoader(id: string, loader: AttachmentDataLoader) {
  let promise: Promise<string> | null = null;
  attachmentDataLoaders.set(id, () => {
    promise ??= loader();
    return promise;
  });
}

export function rememberPickedAttachmentDataBase64(id: string, dataBase64: string) {
  rememberPickedAttachmentDataLoader(id, async () => dataBase64);
}

export function rememberPickedAttachmentDataFile(
  id: string,
  uri: string,
  _options: { deleteOnRelease?: boolean } = {},
) {
  rememberPickedAttachmentDataLoader(id, async () => {
    const response = await fetch(uri);
    const blob = await response.blob();
    const dataUrl = await readFileAsDataUrl(
      blobToFile(blob),
      blob.type || "application/octet-stream",
    );
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  });
}

export async function pickedAttachmentDataBase64(attachment: PickedAttachment): Promise<string> {
  if (attachment.dataBase64) return attachment.dataBase64;
  const loader = attachmentDataLoaders.get(attachment.id);
  if (!loader) throw new Error("Attachment data is no longer available.");
  return loader();
}

export function releasePickedAttachment(attachment: PickedAttachment) {
  attachmentDataLoaders.delete(attachment.id);
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    if (attachment.previewUri.startsWith("blob:")) URL.revokeObjectURL(attachment.previewUri);
  }
}

function blobToFile(blob: Blob): File {
  if (typeof File !== "undefined") {
    return new File([blob], "attachment", { type: blob.type });
  }
  return blob as File;
}

async function readFileAsDataUrl(file: Blob, mimeType: string): Promise<string> {
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        if (result) resolve(result);
        else reject(new Error("Could not read file."));
      };
      reader.readAsDataURL(file);
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
    if (index > 0 && index % 0x80000 === 0) await Promise.resolve();
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}
