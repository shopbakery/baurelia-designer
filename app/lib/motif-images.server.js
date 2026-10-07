import sharp from "sharp";

const MAX_SIDE = 2000;
const MAX_INPUT_PIXELS = 40_000_000;
const MIME_BY_FORMAT = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const masterOptions = (format) => {
  if (format === "png") return { compressionLevel: 9 };
  if (format === "jpeg") return { quality: 92 };
  return { quality: 92, alphaQuality: 100, effort: 5 };
};

export async function buildMotifImages(source, contentType) {
  const input = Buffer.from(source);
  const metadata = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    (metadata.pages || 1) !== 1 ||
    MIME_BY_FORMAT[metadata.format] !== contentType
  ) {
    throw new Error("Die hochgeladene Datei ist kein gültiges PNG-, JPG- oder WebP-Bild.");
  }

  const resizedMaster = Math.max(metadata.width, metadata.height) > MAX_SIDE;
  const master = resizedMaster
    ? await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .autoOrient()
      .resize(MAX_SIDE, MAX_SIDE, { fit: "inside", withoutEnlargement: true })
      .keepIccProfile()
      .toFormat(metadata.format, masterOptions(metadata.format))
      .toBuffer()
    : input;

  const variants = {};
  for (const [name, maxSide] of [["thumbnail", 300], ["preview", 900]]) {
    const { data, info } = await sharp(master, { limitInputPixels: MAX_INPUT_PIXELS })
      .autoOrient()
      .resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82, alphaQuality: 100, effort: 5 })
      .toBuffer({ resolveWithObject: true });
    if (info.format !== "webp" || Math.max(info.width, info.height) > maxSide) {
      throw new Error(`Die ${name}-Datei konnte nicht korrekt erzeugt werden.`);
    }
    variants[name] = data;
  }

  return { master, resizedMaster, variants };
}
