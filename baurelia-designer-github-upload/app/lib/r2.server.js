import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

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
  if (!/^motifs\/[a-z0-9][a-z0-9-]*\/[a-f0-9-]+-[a-z0-9._-]+$/.test(key)) {
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

  const key = `motifs/${categoryHandle}/${randomUUID()}-${safeFileName(fileName)}`;
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

export async function verifyMotifUpload(key) {
  assertMotifKey(key);
  const values = config();
  const result = await client().send(
    new HeadObjectCommand({ Bucket: values.bucket, Key: key }),
  );
  validateMotifUpload({
    contentType: result.ContentType,
    fileSize: Number(result.ContentLength),
  });
  return result;
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
    const publicRoot = new URL(`${config().publicUrl}/`);
    const candidate = new URL(imageUrl);
    if (
      candidate.origin !== publicRoot.origin ||
      !candidate.pathname.startsWith(publicRoot.pathname)
    ) {
      return "";
    }
    const encodedKey = candidate.pathname.slice(publicRoot.pathname.length);
    const key = encodedKey
      .split("/")
      .map((part) => decodeURIComponent(part))
      .join("/");
    assertSafeObjectKey(key);
    return key;
  } catch {
    return "";
  }
}

export function r2PublicUrl(key) {
  const { publicUrl } = config();
  const encodedKey = key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${publicUrl}/${encodedKey}`;
}
