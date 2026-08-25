import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as ImagePicker from "expo-image-picker";

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

function mimeTypeFromName(name: string | null | undefined): string {
  const lower = (name ?? "").toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

export async function pickAttachment(): Promise<PickedAttachment | null> {
  const image = await pickImageAttachment();
  if (image) return image;
  return null;
}

export async function pickFileAttachment(): Promise<PickedAttachment | null> {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset?.uri) throw new Error("Could not read file.");
  const filename = asset.name || "attachment";
  const dataBase64 = await FileSystem.readAsStringAsync(asset.uri, {
    encoding: "base64",
  });
  const mimeType = asset.mimeType ?? mimeTypeFromName(filename);

  return {
    id: localId(),
    kind: kindFromMimeType(mimeType),
    filename,
    mimeType,
    dataBase64,
    previewUri: asset.uri,
    sizeBytes: asset.size,
  };
}

export async function pickImageAttachment(): Promise<PickedImageAttachment | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    allowsMultipleSelection: false,
    base64: true,
    mediaTypes: "images",
    quality: 1,
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset?.uri) throw new Error("Could not read image.");
  const filename = asset.fileName || "image.jpg";
  const mimeType = asset.mimeType ?? mimeTypeFromName(filename);
  const dataBase64 =
    asset.base64 ??
    (await FileSystem.readAsStringAsync(asset.uri, {
      encoding: "base64",
    }));

  return {
    id: localId(),
    kind: "image",
    filename,
    mimeType: mimeType.startsWith("image/") ? mimeType : "image/jpeg",
    dataBase64,
    previewUri: asset.uri,
    sizeBytes: asset.fileSize,
  };
}

export async function attachmentsFromFiles(_files: Iterable<File>): Promise<PickedAttachment[]> {
  return [];
}

export async function attachmentsFromClipboardData(
  _clipboardData?: ClipboardFileSource | null,
): Promise<PickedAttachment[]> {
  return [];
}

export async function imageAttachmentsFromFiles(
  files: Iterable<File>,
): Promise<PickedImageAttachment[]> {
  return attachmentsFromFiles(files);
}
