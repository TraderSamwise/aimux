import type { PickedImage } from "./image-picker";

function stripDataUrlPrefix(dataUrl: string): string {
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

async function fileToBase64(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("failed to read image"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
  return stripDataUrlPrefix(dataUrl);
}

export async function pickImages(): Promise<PickedImage[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = async () => {
      try {
        const files = Array.from(input.files ?? []);
        if (files.length === 0) {
          resolve(null);
          return;
        }
        const out: PickedImage[] = [];
        for (const file of files) {
          const contentBase64 = await fileToBase64(file);
          out.push({
            filename: file.name || "image",
            mimeType: file.type || "application/octet-stream",
            contentBase64,
          });
        }
        resolve(out);
      } catch {
        resolve(null);
      }
    };
    window.addEventListener(
      "focus",
      () =>
        setTimeout(() => {
          if (!input.files?.length) resolve(null);
        }, 500),
      { once: true },
    );
    input.click();
  });
}
