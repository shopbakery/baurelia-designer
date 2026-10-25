import {
  MAX_INPUT_PIXELS,
  motifResolutionMessage,
  resizedMotifDimensions,
  visibleMotifBounds,
} from "./motif-quality.js";

export async function inspectMotifFile(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const originalWidth = bitmap.width;
    const originalHeight = bitmap.height;
    if (!originalWidth || !originalHeight ||
        originalWidth * originalHeight > MAX_INPUT_PIXELS) {
      throw new Error("Das Bild ist ungültig oder für die Verarbeitung zu groß.");
    }

    const { width, height } = resizedMotifDimensions(originalWidth, originalHeight);
    let visible = { width, height };
    if (file.type !== "image/jpeg") {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      try {
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Das Bild konnte nicht geprüft werden.");
        context.drawImage(bitmap, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height).data;
        visible = visibleMotifBounds(pixels, width, height);
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }

    return {
      originalWidth,
      originalHeight,
      masterWidth: width,
      masterHeight: height,
      visibleWidth: visible.width,
      visibleHeight: visible.height,
      error: motifResolutionMessage(visible.width, visible.height),
    };
  } catch (error) {
    return { error: error.message || "Das Bild konnte nicht gelesen werden." };
  } finally {
    bitmap?.close();
  }
}
