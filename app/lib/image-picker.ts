export interface PickedImageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  dataBase64: string;
  previewUri: string;
  sizeBytes?: number;
}

export async function pickImageAttachment(): Promise<PickedImageAttachment | null> {
  throw new Error("Image picker is not available for this platform.");
}
