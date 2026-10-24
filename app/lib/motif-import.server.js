import { createHash } from "node:crypto";

const MAX_BATCH = 10;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const METAOBJECT_ID = /^gid:\/\/shopify\/Metaobject\/\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CATEGORY = /^[a-z0-9][a-z0-9-]*$/;
const MOTIF_ID = /^[a-z0-9][a-z0-9._-]*$/;

const sha256 = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");

export function motifImportKeys(entry) {
  const digest = sha256(`${entry.id}:${entry.sha256}`);
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const relative = `${entry.category_handle}/${uuid}-${entry.motif_id}.png`;
  return {
    master: `motifs-v2/${relative}`,
    thumbnail: `motifs-v2-thumbs/${relative}.webp`,
    preview: `motifs-v2-previews/${relative}.webp`,
  };
}

export function targetMotifFields(entry, publicUrlForKey) {
  if (typeof publicUrlForKey !== "function") {
    throw new TypeError("R2-URL-Funktion fehlt.");
  }
  const keys = motifImportKeys(entry);
  return {
    r2_key: keys.master,
    image_url: publicUrlForKey(keys.master),
    thumbnail_url: publicUrlForKey(keys.thumbnail),
  };
}

const validObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const validFile = (file) =>
  validObject(file) && SHA256.test(file.sha256) &&
  Number.isSafeInteger(file.content_length) &&
  file.content_length > 0 && file.content_length <= MAX_UPLOAD_BYTES;

export function validateMotifImportBatch(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_BATCH) {
    throw new Error(`Pro Durchgang sind 1 bis ${MAX_BATCH} Motive erlaubt.`);
  }
  const ids = new Set();
  const keys = new Set();
  for (const entry of entries) {
    if (!validObject(entry) || !METAOBJECT_ID.test(entry.id || "") ||
        typeof entry.handle !== "string" || !entry.handle ||
        !CATEGORY.test(entry.category_handle || "") ||
        !MOTIF_ID.test(entry.motif_id || "") ||
        typeof entry.old_key !== "string" || !entry.old_key ||
        typeof entry.old_updated_at !== "string" ||
        !Number.isFinite(Date.parse(entry.old_updated_at)) ||
        !SHA256.test(entry.sha256 || "") ||
        !Number.isSafeInteger(entry.content_length) || entry.content_length < 1 ||
        entry.content_length > MAX_UPLOAD_BYTES ||
        !validFile(entry.variants?.thumbnail) || !validFile(entry.variants?.preview)) {
      throw new Error(`Ungültige Motiv-Prüfdaten: ${entry?.motif_id || "unbekannt"}`);
    }
    const key = motifImportKeys(entry).master;
    if (entry.new_key !== key || ids.has(entry.id) || keys.has(key)) {
      throw new Error(`Ungültige oder doppelte Motiv-Zuordnung: ${entry.motif_id}`);
    }
    ids.add(entry.id);
    keys.add(key);
  }
  return entries;
}

function classifyCurrent(entry, current, target, keyFromPublicUrl) {
  if (!validObject(current) || current.id !== entry.id ||
      current.handle !== entry.handle ||
      current.category_handle !== entry.category_handle ||
      !(current.type === "$app:motif" ||
        String(current.type || "").endsWith("--motif"))) {
    throw new Error(`Shopify-ID, Handle oder Kategorie stimmt nicht: ${entry.handle}`);
  }
  const storedKey = String(current.r2_key || keyFromPublicUrl(current.image_url) || "");
  if (storedKey === entry.new_key) {
    if (current.image_url !== target.image_url ||
        current.thumbnail_url !== target.thumbnail_url) {
      throw new Error(`Neuer R2-Schlüssel mit abweichenden URLs: ${entry.handle}`);
    }
    return "already_done";
  }
  if (storedKey !== entry.old_key || current.updatedAt !== entry.old_updated_at) {
    throw new Error(`Motiv wurde seit dem Katalogexport geändert: ${entry.handle}`);
  }
  return "ready";
}

function assertHead(entry, key, head, expected) {
  if (!validObject(head) || Number(head.ContentLength) !== expected.content_length ||
      String(head.ContentType || "").split(";")[0].trim().toLowerCase() !== expected.content_type ||
      String(head.Metadata?.sha256 || "").toLowerCase() !== expected.sha256) {
    throw new Error(`R2-Datei entspricht nicht dem Manifest: ${entry.handle} (${key})`);
  }
}

/** Validate the complete batch before any Shopify mutation. Dependencies are read-only. */
export async function inspectMotifImportBatch(entries, {
  loadMotif, headObject, publicUrlForKey, keyFromPublicUrl = () => "",
}) {
  validateMotifImportBatch(entries);
  if (typeof loadMotif !== "function" || typeof headObject !== "function" ||
      typeof publicUrlForKey !== "function" || typeof keyFromPublicUrl !== "function") {
    throw new TypeError("Shopify- und R2-Lesefunktionen fehlen.");
  }
  const checked = [];
  for (const entry of entries) {
    const current = await loadMotif(entry.id);
    const target = targetMotifFields(entry, publicUrlForKey);
    const status = classifyCurrent(entry, current, target, keyFromPublicUrl);
    const keys = motifImportKeys(entry);
    for (const [key, expected] of [
      [keys.master, { sha256: entry.sha256,
        content_length: entry.content_length, content_type: "image/png" }],
      [keys.thumbnail, { ...entry.variants.thumbnail,
        content_type: "image/webp" }],
      [keys.preview, { ...entry.variants.preview,
        content_type: "image/webp" }],
    ]) {
      const head = await headObject(key);
      assertHead(entry, key, head, expected);
    }
    checked.push({ entry, alreadyDone: status === "already_done",
      target });
  }
  return {
    checked,
    results: checked.map(({ entry, alreadyDone }) => ({
      id: entry.id, handle: entry.handle,
      status: alreadyDone ? "already_done" : "ready",
    })),
  };
}

/** Apply only the image fields, by the known Shopify ID, and read each record back. */
export async function applyMotifImportBatch(checked, {
  loadMotif, updateMotif, publicUrlForKey, keyFromPublicUrl = () => "",
}) {
  if (!Array.isArray(checked) || !checked.length || checked.length > MAX_BATCH ||
      typeof loadMotif !== "function" || typeof updateMotif !== "function" ||
      typeof publicUrlForKey !== "function" || typeof keyFromPublicUrl !== "function") {
    throw new Error("Ungültiger oder zu großer Import-Batch.");
  }
  validateMotifImportBatch(checked.map((item) => item.entry));
  const results = [];
  for (const { entry, target } of checked) {
    if (JSON.stringify(target) !== JSON.stringify(targetMotifFields(entry, publicUrlForKey))) {
      throw new Error(`Ziel-URLs wurden verändert: ${entry.handle}`);
    }
    const before = await loadMotif(entry.id);
    const status = classifyCurrent(entry, before, target, keyFromPublicUrl);
    if (status === "ready") {
      await updateMotif(entry.id, target);
      const after = await loadMotif(entry.id);
      if (classifyCurrent(entry, after, target, keyFromPublicUrl) !== "already_done") {
        throw new Error(`Shopify-Rückleseprüfung fehlgeschlagen: ${entry.handle}`);
      }
    }
    results.push({ id: entry.id, handle: entry.handle,
      status: status === "ready" ? "updated" : "already_done" });
  }
  return results;
}
