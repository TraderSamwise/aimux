export interface PickedImageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  dataBase64: string;
  previewUri: string;
  sizeBytes?: number;
}

const ACCEPTED_IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/gif";

function localId(): string {
  return `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export async function pickImageAttachment(): Promise<PickedImageAttachment | null> {
  if (typeof document === "undefined") return null;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ACCEPTED_IMAGE_TYPES;

  const file = await new Promise<File | null>((resolve) => {
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
  if (!file) return null;

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(",");
  if (comma === -1) throw new Error("Could not read image data.");

  return {
    id: localId(),
    filename: file.name || "image",
    mimeType: file.type || "image/png",
    dataBase64: dataUrl.slice(comma + 1),
    previewUri: dataUrl,
    sizeBytes: file.size,
  };
}
