import * as ImagePicker from "expo-image-picker";
import type { PickedImage } from "./image-picker";

export async function pickImages(): Promise<PickedImage[] | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return null;

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsMultipleSelection: true,
    quality: 0.8,
    base64: true,
  });
  if (result.canceled) return null;

  const out: PickedImage[] = [];
  for (const asset of result.assets) {
    if (!asset.base64) continue;
    out.push({
      filename: asset.fileName ?? "image.jpg",
      mimeType: asset.mimeType ?? "image/jpeg",
      contentBase64: asset.base64,
    });
  }
  return out.length ? out : null;
}
