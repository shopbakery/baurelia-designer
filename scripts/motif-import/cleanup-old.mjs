import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const OUTPUT = path.join(ROOT, "r2-speicher-vergleich/outputs/motif-import");
const MANIFEST_FILES = ["manifest.json", "manifest-approved-review.json"];
const REPORT_FILE = path.join(OUTPUT, "old-asset-cleanup-plan.json");
const SHOP = "3f14b7-2.myshopify.com";
const PUBLIC_ORIGIN = "https://media.baurelia.ch";
const PREFIXES = ["motifs-v2/", "motifs-v2-thumbs/", "motifs-v2-previews/"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function variantKeys(key) {
  if (typeof key !== "string" || !key.startsWith("motifs-v2/") ||
      !key.toLowerCase().endsWith(".png") || path.posix.normalize(key) !== key ||
      key.split("/").some((part) => part === ".." || part === "." || !part)) {
    throw new Error(`Ungültiger Druckbild-Schlüssel: ${key}`);
  }
  const relative = key.slice("motifs-v2/".length);
  return {
    master: key,
    thumbnail: `motifs-v2-thumbs/${relative}.webp`,
    preview: `motifs-v2-previews/${relative}.webp`,
  };
}

function publicKey(url) {
  if (typeof url !== "string" || !url) return "";
  const parsed = new URL(url);
  if (parsed.origin !== PUBLIC_ORIGIN) return "";
  return decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
}

export function buildCleanupPlan(catalog, manifests, objects) {
  if (catalog?.schema !== 1 || catalog.shop !== SHOP ||
      catalog.source !== "existing_store_app_proxy" ||
      catalog.scope !== "active_categories_and_verified_active_motifs" ||
      !Array.isArray(catalog.motifs) || catalog.motifs.length < 1 ||
      !manifests.every((manifest) => manifest?.schema === 1 &&
        manifest.shop === SHOP && Array.isArray(manifest.entries))) {
    throw new Error("Shopify-Katalog oder Importmanifeste sind ungültig.");
  }
  const entries = manifests.flatMap((manifest) => manifest.entries);
  const currentById = new Map(catalog.motifs.map((motif) => [motif.id, motif]));
  if (currentById.size !== catalog.motifs.length) {
    throw new Error("Doppelte Metaobjekt-ID im aktuellen Shopify-Katalog.");
  }
  const ids = new Set();
  const oldKeys = new Set();
  const newKeys = new Set();
  const expectedNew = [];
  for (const entry of entries) {
    const old = variantKeys(entry.old_key);
    const newer = variantKeys(entry.new_key);
    if (ids.has(entry.id) || oldKeys.has(old.master) || old.master === newer.master ||
        typeof entry.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !Number.isSafeInteger(entry.content_length) || entry.content_length < 1) {
      throw new Error(`Mehrdeutiges oder ungültiges Importmotiv: ${entry.motif_id}`);
    }
    const current = currentById.get(entry.id);
    if (!current || current.handle !== entry.handle ||
        current.category_handle !== entry.category_handle ||
        current.r2_key !== newer.master ||
        publicKey(current.image_url) !== newer.master ||
        publicKey(current.thumbnail_url) !== newer.thumbnail) {
      throw new Error(`Shopify verwendet nicht alle neuen Dateien: ${entry.motif_id}`);
    }
    ids.add(entry.id);
    oldKeys.add(old.master);
    for (const key of Object.values(newer)) newKeys.add(key);
    expectedNew.push({ key: newer.master, bytes: entry.content_length, sha256: entry.sha256 });
    for (const name of ["thumbnail", "preview"]) {
      const variant = entry.variants?.[name];
      if (!variant || !Number.isSafeInteger(variant.content_length) ||
          variant.content_length < 1 || !/^[a-f0-9]{64}$/.test(variant.sha256 || "")) {
        throw new Error(`Ungültige neue Vorschau: ${entry.motif_id}`);
      }
      expectedNew.push({ key: newer[name], bytes: variant.content_length, sha256: variant.sha256 });
    }
  }
  const oldCandidates = entries.flatMap((entry) => Object.values(variantKeys(entry.old_key)));
  const candidateSet = new Set(oldCandidates);
  if (candidateSet.size !== oldCandidates.length || newKeys.size !== entries.length * 3 ||
      oldCandidates.some((key) => newKeys.has(key))) {
    throw new Error("Alte Schlüssel sind doppelt oder werden auch als neue Dateien benötigt.");
  }
  for (const motif of catalog.motifs) {
    for (const key of [motif.r2_key, publicKey(motif.image_url), publicKey(motif.thumbnail_url)]) {
      if (candidateSet.has(key)) {
        throw new Error(`Alte Datei wird weiterhin im aktiven Katalog verwendet: ${key}`);
      }
    }
  }
  for (const expected of expectedNew) {
    const actual = objects.get(expected.key);
    if (!actual || actual.bytes !== expected.bytes) {
      throw new Error(`Neue Datei fehlt in R2 oder hat eine andere Größe: ${expected.key}`);
    }
  }
  const toDelete = oldCandidates.filter((key) => objects.has(key))
    .map((key) => ({ key, bytes: objects.get(key).bytes }));
  return {
    shop: SHOP,
    catalog_exported_at: catalog.exported_at,
    switched_motifs: entries.length,
    expected_new: expectedNew,
    missing_old: oldCandidates.length - toDelete.length,
    objects: toDelete,
    bytes_to_delete: toDelete.reduce((sum, item) => sum + item.bytes, 0),
  };
}

async function simpleEnv(file) {
  const values = {};
  for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) values[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

async function listMotifObjects(storage, bucket) {
  const objects = new Map();
  for (const prefix of PREFIXES) {
    let cursor;
    do {
      const page = await storage.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, ContinuationToken: cursor,
      }));
      for (const item of page.Contents || []) {
        if (objects.has(item.Key)) throw new Error(`Doppelter R2-Schlüssel: ${item.Key}`);
        objects.set(item.Key, { bytes: Number(item.Size) });
      }
      cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !cursor) throw new Error(`R2-Liste für ${prefix} unvollständig.`);
    } while (cursor);
  }
  return objects;
}

async function writeJsonAtomic(file, data) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function main() {
  const args = process.argv.slice(2);
  const deleteRequested = args.includes("--delete");
  const catalogIndex = args.indexOf("--catalog");
  if (catalogIndex < 0 || catalogIndex + 1 >= args.length ||
      args.some((arg, index) => arg !== "--delete" && arg !== "--catalog" && index !== catalogIndex + 1)) {
    throw new Error("Verwendung: node cleanup-old.mjs --catalog PFAD [--delete]");
  }
  const catalogPath = path.resolve(args[catalogIndex + 1]);
  const catalogBytes = await readFile(catalogPath);
  const catalog = JSON.parse(catalogBytes);
  const manifestBytes = await Promise.all(MANIFEST_FILES.map((name) => readFile(path.join(OUTPUT, name))));
  const manifests = manifestBytes.map((bytes) => JSON.parse(bytes));
  const r2 = await simpleEnv(path.join(ROOT, "r2-speicher-vergleich/.env"));
  const app = await simpleEnv(path.join(ROOT, "baurelia-designer/scripts/r2-resize/.env"));
  const account = r2.NEW_R2_ACCOUNT_ID;
  const bucket = r2.NEW_R2_BUCKET;
  const endpoint = r2.NEW_R2_ENDPOINT_URL || `https://${account}.r2.cloudflarestorage.com`;
  if (!account || !r2.NEW_R2_ACCESS_KEY_ID || !r2.NEW_R2_SECRET_ACCESS_KEY ||
      !bucket || bucket !== app.R2_BUCKET_NAME || account !== app.R2_ACCOUNT_ID ||
      endpoint !== `https://${account}.r2.cloudflarestorage.com` ||
      app.R2_PUBLIC_URL !== PUBLIC_ORIGIN) {
    throw new Error("R2-Konfiguration passt nicht zum Baurelia-Ziel-Bucket.");
  }
  const storage = new S3Client({ region: "auto", endpoint, forcePathStyle: true,
    credentials: { accessKeyId: r2.NEW_R2_ACCESS_KEY_ID,
      secretAccessKey: r2.NEW_R2_SECRET_ACCESS_KEY }, maxAttempts: 4 });
  const objects = await listMotifObjects(storage, bucket);
  const plan = buildCleanupPlan(catalog, manifests, objects);
  const fingerprint = sha256(Buffer.from(JSON.stringify({
    catalog_sha256: sha256(catalogBytes),
    manifest_sha256: manifestBytes.map(sha256),
    objects: plan.objects,
  })));
  console.log(`${plan.switched_motifs} Shopify-Motive umgestellt; ${plan.objects.length} alte Dateien vorhanden; ` +
    `${(plan.bytes_to_delete / 1024 ** 3).toFixed(2)} GiB löschbar; ` +
    `${plan.missing_old} alte Dateien nicht im Ziel-Bucket vorhanden.`);
  if (!deleteRequested) {
    await writeJsonAtomic(REPORT_FILE, { schema: 1, generated_at: new Date().toISOString(),
      catalog_file: catalogPath, fingerprint, ...plan });
    console.log(`Nur Vorprüfung. Löschplan: ${REPORT_FILE}`);
    return;
  }
  const saved = JSON.parse(await readFile(REPORT_FILE, "utf8"));
  const now = Date.now();
  if (saved.schema !== 1 || saved.fingerprint !== fingerprint ||
      saved.catalog_file !== catalogPath ||
      now - Date.parse(saved.generated_at) > 10 * 60_000 ||
      now - Date.parse(catalog.exported_at) > 15 * 60_000 ||
      now < Date.parse(saved.generated_at) || now < Date.parse(catalog.exported_at)) {
    throw new Error("Löschplan oder Shopify-Katalog ist verändert oder zu alt. Bitte neu prüfen.");
  }
  // Verify every replacement through R2 metadata before deleting any old asset.
  for (let index = 0; index < plan.expected_new.length; index += 16) {
    const batch = plan.expected_new.slice(index, index + 16);
    await Promise.all(batch.map(async (expected) => {
      const head = await storage.send(new HeadObjectCommand({ Bucket: bucket, Key: expected.key }));
      const expectedType = expected.key.endsWith(".webp") ? "image/webp" : "image/png";
      if (Number(head.ContentLength) !== expected.bytes || head.ContentType !== expectedType ||
          head.Metadata?.sha256 !== expected.sha256) {
        throw new Error(`Neue Datei ist nicht verifiziert: ${expected.key}`);
      }
    }));
    if ((index + batch.length) % 400 === 0) {
      console.log(`${index + batch.length}/${plan.expected_new.length} neue Dateien nochmals geprüft.`);
    }
  }
  console.log(`${plan.expected_new.length} neue Dateien verifiziert. Lösche ausschließlich die alten Planziele.`);
  let deleted = 0;
  for (let index = 0; index < plan.objects.length; index += 16) {
    const batch = plan.objects.slice(index, index + 16);
    await Promise.all(batch.map((item) => storage.send(new DeleteObjectCommand({
      Bucket: bucket, Key: item.key,
    }))));
    deleted += batch.length;
    if (deleted % 200 < 16 || deleted === plan.objects.length) {
      console.log(`${deleted}/${plan.objects.length} alte Dateien gelöscht.`);
    }
  }
  const after = await listMotifObjects(storage, bucket);
  const remaining = plan.objects.filter((item) => after.has(item.key));
  if (remaining.length) {
    throw new Error(`${remaining.length} alte Dateien sind nach dem Löschen noch vorhanden.`);
  }
  console.log(`${deleted} alte R2-Dateien entfernt und durch erneute Bucket-Liste bestätigt.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
