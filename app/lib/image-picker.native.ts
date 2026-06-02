import * as ImagePicker from "expo-image-picker";

export interface PickedImageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  dataBase64: string;
  previewUri: string;
  sizeBytes?: number;
}

function localId(): string {
  return `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function mimeTypeFromName(name: string | null | undefined): string {
  const lower = (name ?? "").toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
}

function filenameFromUri(uri: string): string {
  const tail = uri.split("/").filter(Boolean).pop();
  return tail && tail.includes(".") ? tail : "image.png";
}

export async function pickImageAttachment(): Promise<PickedImageAttachment | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new Error("Photo library permission is required.");

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    base64: true,
    quality: 1,
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset?.base64) throw new Error("Could not read image data.");
  const filename = asset.fileName ?? filenameFromUri(asset.uri);

  return {
    id: localId(),
    filename,
    mimeType: asset.mimeType ?? mimeTypeFromName(filename),
    dataBase64: asset.base64,
    previewUri: asset.uri,
    sizeBytes: asset.fileSize,
  };
}
