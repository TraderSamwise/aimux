export interface PickedImage {
  filename: string;
  mimeType: string;
  contentBase64: string;
}

export function pickImages(): Promise<PickedImage[] | null>;
