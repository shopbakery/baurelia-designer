import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import migratedMotifKeys from "../data/motif-v2-map.js";
import { buildMotifImages } from "./motif-images.server.js";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const LEGACY_MOTIF_PUBLIC_URL =
  "https://pub-049e86916f8f447aab9e07fd4144ab91.r2.dev";
const MOTIF_PREFIX = "motifs-v2";
const VARIANT_CACHE_CONTROL = "public, max-age=31536000, immutable";

const requiredEnv = (key) => {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Umgebungsvariable ${key} fehlt.`);
  return value;
};

const config = () => ({
  accountId: requiredEnv("R2_ACCOUNT_ID"),
  accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
  secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
  bucket: requiredEnv("R2_BUCKET_NAME"),
  publicUrl: requiredEnv("R2_PUBLIC_URL").replace(/\/+$/, ""),
});

const client = () => {
  const values = config();
  return new S3Client({
    region: "auto",
    endpoint: `https://${values.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: values.accessKeyId,
      secretAccessKey: values.secretAccessKey,
    },
  });
};

const safeFileName = (fileName) => {
  const normalized = fileName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "motiv.png";
};

const assertMotifKey = (key) => {
  // Accept old in-flight uploads during a rolling app deployment.
  if (!/^motifs(?:-v2)?\/[a-z0-9][a-z0-9-]*\/[a-f0-9-]+-[a-z0-9._-]+$/.test(key)) {
    throw new Error("Ungültiger R2-Objektschlüssel.");
  }
};

const assertSafeObjectKey = (key) => {
  const segments = String(key || "").split("/");
  if (
    !key ||
    key.length > 1024 ||
    key.includes("\\") ||
    [...key].some((character) => character.charCodeAt(0) < 32) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Ungültiger R2-Objektschlüssel.");
  }
};

export const validateMotifUpload = ({ contentType, fileSize }) => {
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error("Erlaubt sind PNG-, JPG- und WebP-Dateien.");
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    throw new Error("Die Bilddatei ist leer oder ungültig.");
  }
  if (fileSize > MAX_UPLOAD_BYTES) {
    throw new Error("Die Bilddatei darf höchstens 10 MB groß sein.");
  }
};

export async function createMotifUpload({
  fileName,
  contentType,
  fileSize,
  categoryHandle,
}) {
  validateMotifUpload({ contentType, fileSize });
  if (!/^[a-z0-9][a-z0-9-]*$/.test(categoryHandle)) {
    throw new Error("Die ausgewählte Kategorie ist ungültig.");
  }

  const key = `${MOTIF_PREFIX}/${categoryHandle}/${randomUUID()}-${safeFileName(fileName)}`;
  const values = config();
  const uploadUrl = await getSignedUrl(
    client(),
    new PutObjectCommand({
      Bucket: values.bucket,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: 600 },
  );

  return { key, uploadUrl, publicUrl: r2PublicUrl(key) };
}

export async function verifyMotifUpload(key, options = {}) {
  assertMotifKey(key);
  const bucket = options.bucket || config().bucket;
  const storage = options.storage || client();
  const result = await storage.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key }),
  );
  validateMotifUpload({
    contentType: result.ContentType,
    fileSize: Number(result.ContentLength),
  });
  return result;
}

export function motifVariantKeys(key) {
  assertSafeObjectKey(key);
  if (!key.startsWith(`${MOTIF_PREFIX}/`)) return null;
  const relativeKey = key.slice(MOTIF_PREFIX.length + 1);
  return {
    thumbnail: `motifs-v2-thumbs/${relativeKey}.webp`,
    preview: `motifs-v2-previews/${relativeKey}.webp`,
  };
}

const verifyVariant = async (storage, bucket, key) => {
  const result = await storage.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (result.ContentType !== "image/webp" || Number(result.ContentLength) <= 0) {
    throw new Error(`Die erzeugte Motivvariante ist ungültig: ${key}`);
  }
};

export async function completeMotifImages(key, options = {}) {
  assertMotifKey(key);
  const variantKeys = motifVariantKeys(key);
  if (!variantKeys) {
    throw new Error("Neue Motive müssen im motifs-v2-Ordner liegen.");
  }

  const bucket = options.bucket || config().bucket;
  const storage = options.storage || client();
  const uploaded = await verifyMotifUpload(key, { bucket, storage });
  const response = await storage.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      IfMatch: uploaded.ETag,
    }),
  );
  const source = Buffer.from(await response.Body.transformToByteArray());
  if (source.length !== Number(uploaded.ContentLength)) {
    throw new Error("Die hochgeladene Motivdatei ist unvollständig.");
  }
  const prepared = await buildMotifImages(source, uploaded.ContentType);
  validateMotifUpload({
    contentType: uploaded.ContentType,
    fileSize: prepared.master.length,
  });

  if (prepared.resizedMaster) {
    await storage.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: prepared.master,
        ContentType: uploaded.ContentType,
        CacheControl: VARIANT_CACHE_CONTROL,
        IfMatch: uploaded.ETag,
      }),
    );
    const finalMaster = await storage.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (
      finalMaster.ContentType !== uploaded.ContentType ||
      Number(finalMaster.ContentLength) !== prepared.master.length
    ) {
      throw new Error("Das verkleinerte Druckbild konnte nicht geprüft werden.");
    }
  }

  for (const [name, variantKey] of Object.entries(variantKeys)) {
    try {
      await storage.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: variantKey,
          Body: prepared.variants[name],
          ContentType: "image/webp",
          CacheControl: VARIANT_CACHE_CONTROL,
          IfNoneMatch: "*",
        }),
      );
    } catch (error) {
      if (error?.$metadata?.httpStatusCode !== 412) throw error;
    }
    await verifyVariant(storage, bucket, variantKey);
  }

  return {
    imageUrl: r2PublicUrl(key),
    thumbnailUrl: r2PublicUrl(variantKeys.thumbnail),
    previewUrl: r2PublicUrl(variantKeys.preview),
  };
}

export async function deleteMotifObject(key) {
  assertSafeObjectKey(key);
  const values = config();
  await client().send(
    new DeleteObjectCommand({ Bucket: values.bucket, Key: key }),
  );
}

export function motifKeyFromPublicUrl(imageUrl) {
  try {
    const candidate = new URL(imageUrl);
    const publicRoots = [
      requiredEnv("R2_PUBLIC_URL"),
      LEGACY_MOTIF_PUBLIC_URL,
    ];
    for (const publicUrl of publicRoots) {
      const publicRoot = new URL(`${publicUrl.replace(/\/+$/, "")}/`);
      if (
        candidate.origin !== publicRoot.origin ||
        !candidate.pathname.startsWith(publicRoot.pathname)
      ) {
        continue;
      }
      const encodedKey = candidate.pathname.slice(publicRoot.pathname.length);
      const key = encodedKey
        .split("/")
        .map((part) => decodeURIComponent(part))
        .join("/");
      assertSafeObjectKey(key);
      return key;
    }
    return "";
  } catch {
    return "";
  }
}

export async function deleteMotifAssets(key) {
  const variantKeys = motifVariantKeys(key);
  const keys = [key, ...(variantKeys ? Object.values(variantKeys) : [])];
  const results = await Promise.allSettled(keys.map(deleteMotifObject));
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("Mindestens eine R2-Motivdatei konnte nicht entfernt werden.");
  }
}

export function currentMotifKey(motif) {
  const storedKey =
    motif.r2_key ||
    motifKeyFromPublicUrl(motif.image_url || motif.imageUrl);
  return migratedMotifKeys[storedKey] || storedKey;
}

export function hasVerifiedMotifObject(motif) {
  const storedKey =
    motif.r2_key ||
    motifKeyFromPublicUrl(motif.image_url || motif.imageUrl);
  // Legacy direct uploads not present in the completed migration may be broken.
  // Keep them visible in the admin, but never offer them to shoppers.
  return !storedKey.startsWith("motifs/") || Boolean(migratedMotifKeys[storedKey]);
}

export function motifWithCurrentPublicUrls(motif) {
  const imageField = motif.image_url ? "image_url" : "imageUrl";
  const thumbnailField = motif.thumbnail_url ? "thumbnail_url" : "thumbnailUrl";
  const imageUrl = motif[imageField];
  const key = currentMotifKey(motif);
  if (!key || !imageUrl) return motif;

  const currentImageUrl = r2PublicUrl(key);
  const variantKeys = motifVariantKeys(key);
  if (variantKeys) {
    return {
      ...motif,
      [imageField]: currentImageUrl,
      [thumbnailField]: r2PublicUrl(variantKeys.thumbnail),
      previewUrl: r2PublicUrl(variantKeys.preview),
      r2_key: key,
    };
  }

  const existingThumbnailUrl = String(motif[thumbnailField] || "");
  let thumbnailUrl = currentImageUrl;
  try {
    const thumbnail = new URL(existingThumbnailUrl);
    if (thumbnail.hostname === "images.weserv.nl") {
      thumbnail.searchParams.set(
        "url",
        currentImageUrl.replace(/^https?:\/\//, ""),
      );
      thumbnailUrl = thumbnail.toString();
    } else {
      const thumbnailKey = motifKeyFromPublicUrl(existingThumbnailUrl);
      if (thumbnailKey && thumbnailKey !== key) {
        thumbnailUrl = r2PublicUrl(migratedMotifKeys[thumbnailKey] || thumbnailKey);
      } else if (!thumbnailKey) {
        thumbnailUrl = existingThumbnailUrl;
      }
    }
  } catch {
    // A missing thumbnail can use the public original image instead.
  }

  return {
    ...motif,
    [imageField]: currentImageUrl,
    [thumbnailField]: thumbnailUrl,
    previewUrl: currentImageUrl,
    r2_key: key,
  };
}

export function r2PublicUrl(key) {
  const publicUrl = requiredEnv("R2_PUBLIC_URL").replace(/\/+$/, "");
  const encodedKey = key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${publicUrl}/${encodedKey}`;
}
