import { createHash } from "node:crypto";
import { readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const PLAN = path.join(ROOT, "r2-speicher-vergleich/outputs/motif-import/plan.json");
const OUTPUT_DIR = path.dirname(PLAN);
const SOURCE_INVENTORY = path.join(OUTPUT_DIR, "sources.json");
const SHOP = "3f14b7-2.myshopify.com";
const REVIEW_EXCLUSIONS = new Set([
  "motorrad-13", "fuchs-34", "fuchs-35", "fuchs-36",
  "fuchs-10", "fuchs-12", "fussball-14",
]);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const CACHE = "public, max-age=31536000, immutable";
const VARIANT_SIDES = { thumbnail: 300, preview: 900 };

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function parseArgs(args) {
  const options = { upload: false, limit: null, all: false, approvedOnly: false, approve: null };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--upload") options.upload = true;
    else if (args[i] === "--all") options.all = true;
    else if (args[i] === "--approved-only") options.approvedOnly = true;
    else if (args[i] === "--limit") options.limit = Number(args[++i]);
    else if (args[i] === "--approve-review") options.approve = args[++i];
    else throw new Error(`Unbekannte Option: ${args[i]}`);
  }
  if (Number(options.all) + Number(options.approvedOnly) + Number(options.limit !== null) !== 1 ||
      (options.limit !== null && (!Number.isInteger(options.limit) || options.limit < 1))) {
    throw new Error("Genau eine Auswahl angeben: --limit N, --all oder --approved-only.");
  }
  if (options.approvedOnly && !options.approve) {
    throw new Error("--approved-only erfordert --approve-review DATEI.");
  }
  return options;
}

async function simpleEnv(file) {
  const values = {};
  for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) values[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

function uuidFor(item) {
  const hash = sha256(Buffer.from(`${item.id}:${item.source_sha256}`, "utf8"));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function objectKeys(item) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(item.category_handle) ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(item.motif_id)) {
    throw new Error(`Ungültiger Name im Plan: ${item.motif_id}`);
  }
  const relative = `${item.category_handle}/${uuidFor(item)}-${item.motif_id}.png`;
  return {
    master: `motifs-v2/${relative}`,
    thumbnail: `motifs-v2-thumbs/${relative}.webp`,
    preview: `motifs-v2-previews/${relative}.webp`,
  };
}

export function validatePlan(plan) {
  if (plan?.schema !== 1 || plan.shop !== SHOP || !path.isAbsolute(plan.base_dir || "") ||
      !Array.isArray(plan.entries) || !Array.isArray(plan.unresolved)) {
    throw new Error("Plan ist ungültig oder gehört zum falschen Shop.");
  }
  const ids = new Set();
  const keys = new Set();
  for (const item of plan.entries) {
    if (!/^gid:\/\/shopify\/Metaobject\/\d+$/.test(item.id || "") ||
        typeof item.handle !== "string" || !item.handle ||
        typeof item.source_path !== "string" || !item.source_path ||
        !/^[a-f0-9]{64}$/.test(item.source_sha256 || "") ||
        !Number.isSafeInteger(item.source_bytes) || item.source_bytes < 1 ||
        !Number.isSafeInteger(item.width) || item.width < 1 ||
        !Number.isSafeInteger(item.height) || item.height < 1 ||
        typeof item.has_alpha !== "boolean" || typeof item.needs_review !== "boolean") {
      throw new Error(`Ungültiger Planeintrag: ${item?.motif_id || "unbekannt"}`);
    }
    const masterKey = objectKeys(item).master;
    if (ids.has(item.id) || keys.has(masterKey)) {
      throw new Error(`Doppelte Metaobjekt-ID oder R2-Ziel im Plan: ${item.motif_id}`);
    }
    ids.add(item.id);
    keys.add(masterKey);
  }
}

export function selectApprovedReview(plan, inventory, approval) {
  if (approval?.schema !== 1 || inventory?.schema !== 1 || !Array.isArray(inventory.items)) {
    throw new Error("Prüffreigabe oder Quellinventar ungültig.");
  }
  const groups = ["approved_motif_ids", "approved_without_safe_shopify_target", "excluded_motif_ids"];
  const all = [];
  for (const group of groups) {
    if (!Array.isArray(approval[group]) ||
        !approval[group].every((id) => typeof id === "string" && id.length > 0)) {
      throw new Error(`Prüffreigabe ohne gültige Liste ${group}.`);
    }
    all.push(...approval[group]);
  }
  if (new Set(all).size !== all.length) throw new Error("Doppelte Motiv-ID in der Prüffreigabe.");
  const reviewIds = inventory.items.filter((item) => item.needs_review).map((item) => item.motif_id);
  if (new Set(reviewIds).size !== reviewIds.length || all.length !== reviewIds.length ||
      all.some((id) => !reviewIds.includes(id))) {
    throw new Error("Prüffreigabe deckt die Qualitätsprüfliste nicht exakt ab.");
  }
  const excluded = new Set(approval.excluded_motif_ids);
  if (excluded.size !== REVIEW_EXCLUSIONS.size ||
      [...REVIEW_EXCLUSIONS].some((id) => !excluded.has(id))) {
    throw new Error("Die sieben vom Nutzer ausgeschlossenen Motive müssen ausgeschlossen bleiben.");
  }
  const planByMotif = new Map(plan.entries.map((item) => [item.motif_id, item]));
  if (planByMotif.size !== plan.entries.length) {
    throw new Error("Mehrdeutige Motiv-ID im Shopify-Zuordnungsplan.");
  }
  if (approval.approved_motif_ids.some((id) => !planByMotif.get(id)?.needs_review) ||
      approval.approved_without_safe_shopify_target.some((id) => planByMotif.has(id))) {
    throw new Error("Freigabe und Shopify-Zuordnung stimmen nicht überein.");
  }
  const approved = new Set(approval.approved_motif_ids);
  return plan.entries.filter((item) => item.needs_review && approved.has(item.motif_id));
}

async function sourcePath(baseDir, relativePath) {
  if (path.isAbsolute(relativePath)) throw new Error(`Absoluter Quellpfad: ${relativePath}`);
  const base = await realpath(baseDir);
  const absolute = await realpath(path.resolve(baseDir, relativePath));
  const relative = path.relative(base, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      !(await stat(absolute)).isFile()) {
    throw new Error(`Quelldatei außerhalb des Inventars: ${relativePath}`);
  }
  return absolute;
}

export async function verifySourceBytes(item, baseDir) {
  const absolute = await sourcePath(baseDir, item.source_path);
  const source = await readFile(absolute);
  if (source.length !== item.source_bytes || sha256(source) !== item.source_sha256) {
    throw new Error(`Quelldatei hat sich seit dem Inventar geändert: ${item.motif_id}`);
  }
  return source;
}

export async function prepareItem(item, baseDir) {
  const master = await verifySourceBytes(item, baseDir);
  const metadata = await sharp(master, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  if (metadata.format !== "png" || (metadata.pages || 1) !== 1 ||
      metadata.width !== item.width || metadata.height !== item.height ||
      metadata.hasAlpha !== item.has_alpha) {
    throw new Error(`PNG-Metadaten stimmen nicht mit dem Inventar überein: ${item.motif_id}`);
  }
  // The app's image helper caps masters at 2000 px. Print masters must instead
  // retain the approved PNG's original pixels and dimensions, byte for byte.
  if (master.length > MAX_UPLOAD_BYTES) {
    throw new Error(`Druckbild größer als 10 MB: ${item.motif_id}`);
  }
  const variants = {};
  const variantDetails = {};
  for (const [name, maxSide] of Object.entries(VARIANT_SIDES)) {
    const { data, info } = await sharp(master, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82, alphaQuality: 100, effort: 5 })
      .toBuffer({ resolveWithObject: true });
    if (info.format !== "webp" || !info.width || !info.height ||
        Math.max(info.width, info.height) > maxSide || !data.length) {
      throw new Error(`${name} konnte nicht korrekt erzeugt werden: ${item.motif_id}`);
    }
    variants[name] = data;
    variantDetails[name] = { sha256: sha256(data), bytes: data.length,
      width: info.width, height: info.height };
  }
  return {
    master, variants,
    details: {
      id: item.id,
      motif_id: item.motif_id,
      source_path: item.source_path,
      keys: objectKeys(item),
      master: { sha256: sha256(master), bytes: master.length,
        width: metadata.width, height: metadata.height, has_alpha: metadata.hasAlpha },
      variants: variantDetails,
    },
  };
}

export function selectionFingerprint(planSha256, approvalSha256, options, selected) {
  return sha256(Buffer.from(JSON.stringify({
    schema: 2, shop: SHOP, plan_sha256: planSha256, approval_sha256: approvalSha256,
    selection: options.approvedOnly ? "approved_review_only" :
      options.all ? "all_eligible" : `first_${options.limit}`,
    selected: selected.map((item) => ({ id: item.id, motif_id: item.motif_id,
      source_sha256: item.source_sha256, keys: objectKeys(item) })),
  })));
}

export function verifyPreflightReport(report, fingerprint, selected) {
  if (report?.schema !== 2 || report.shop !== SHOP || report.status !== "passed" ||
      report.selection_fingerprint !== fingerprint ||
      !Array.isArray(report.entries) || report.entries.length !== selected.length ||
      !Array.isArray(report.errors) || report.errors.length) {
    throw new Error("Vorprüfung fehlt, ist fehlgeschlagen oder passt nicht zum aktuellen Plan/der Auswahl.");
  }
  for (const [index, item] of selected.entries()) {
    const entry = report.entries[index];
    if (entry?.id !== item.id || entry.motif_id !== item.motif_id ||
        entry.source_path !== item.source_path ||
        JSON.stringify(entry.keys) !== JSON.stringify(objectKeys(item)) ||
        entry.master?.sha256 !== item.source_sha256 ||
        entry.master.bytes !== item.source_bytes ||
        entry.master.width !== item.width || entry.master.height !== item.height ||
        entry.master.has_alpha !== item.has_alpha ||
        !entry.variants?.thumbnail?.sha256 || !entry.variants?.preview?.sha256) {
      throw new Error(`Vorprüfungsbericht passt nicht zu ${item.motif_id}.`);
    }
  }
}

export async function preflightSelection(selected, baseDir, fingerprint, context = {}) {
  const entries = [];
  const errors = [];
  for (const [index, item] of selected.entries()) {
    try {
      const prepared = await prepareItem(item, baseDir);
      entries.push(prepared.details);
      console.log(`[${index + 1}/${selected.length}] OK ${item.motif_id}: ` +
        `${prepared.details.master.width}×${prepared.details.master.height} px, ` +
        `${prepared.details.master.bytes} Bytes (Master unverändert)`);
    } catch (error) {
      errors.push({ motif_id: item.motif_id, error: error.message });
      console.error(`[${index + 1}/${selected.length}] FEHLER ${item.motif_id}: ${error.message}`);
    }
  }
  return {
    schema: 2, shop: SHOP, generated_at: new Date().toISOString(),
    status: errors.length ? "failed" : "passed",
    selection_fingerprint: fingerprint,
    ...context,
    selected_count: selected.length,
    entries, errors,
  };
}

async function putChecked(storage, bucket, key, body, contentType) {
  const digest = sha256(body);
  try {
    await storage.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: body.length,
      CacheControl: CACHE,
      Metadata: { sha256: digest },
      IfNoneMatch: "*",
    }));
  } catch (error) {
    if (error?.$metadata?.httpStatusCode !== 412) throw error;
  }
  const head = await storage.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (Number(head.ContentLength) !== body.length || head.ContentType !== contentType ||
      head.Metadata?.sha256 !== digest) {
    throw new Error(`R2-Konflikt oder fehlerhafter Upload: ${key}`);
  }
  return digest;
}

async function writeJsonAtomic(file, data) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const planBytes = await readFile(PLAN);
  const plan = JSON.parse(planBytes.toString("utf8"));
  validatePlan(plan);
  let approved = new Set();
  let approvalSha256 = null;
  let approvalDocument = null;
  if (options.approve) {
    const approvalBytes = await readFile(path.resolve(options.approve));
    approvalDocument = JSON.parse(approvalBytes.toString("utf8"));
    if (!Array.isArray(approvalDocument.approved_motif_ids) ||
        !approvalDocument.approved_motif_ids.every((id) => typeof id === "string") ||
        new Set(approvalDocument.approved_motif_ids).size !== approvalDocument.approved_motif_ids.length) {
      throw new Error("Prüffreigabe ungültig.");
    }
    approved = new Set(approvalDocument.approved_motif_ids);
    approvalSha256 = sha256(approvalBytes);
  }
  const reviewSelection = options.approvedOnly ? selectApprovedReview(plan,
    JSON.parse(await readFile(SOURCE_INVENTORY, "utf8")), approvalDocument) : null;
  const eligible = plan.entries.filter((item) => !item.needs_review || approved.has(item.motif_id));
  const selected = options.approvedOnly ? reviewSelection :
    options.all ? eligible : eligible.slice(0, options.limit);
  if (!selected.length) throw new Error("Keine Motive für diese Auswahl vorhanden.");
  const selection = options.approvedOnly ? "approved_review_only" :
    options.all ? "all_eligible" : `first_${options.limit}`;
  const planSha256 = sha256(planBytes);
  const fingerprint = selectionFingerprint(planSha256, approvalSha256, options, selected);
  const reportPath = path.join(OUTPUT_DIR, options.approvedOnly ? "preflight-approved-review.json" :
    options.all ? "preflight-all.json" : `preflight-${options.limit}.json`);
  console.log(`Zugeordnet: ${plan.entries.length}; bereit: ${eligible.length}; ausgewählt: ${selected.length}; ` +
    `offen: ${plan.unresolved.length}; Qualitätsprüfung offen: ${plan.entries.length - eligible.length}.`);
  if (!options.upload) {
    const report = await preflightSelection(selected, plan.base_dir, fingerprint,
      { plan_sha256: planSha256, approval_sha256: approvalSha256, selection });
    await writeJsonAtomic(reportPath, report);
    console.log(`Offline-Vorprüfung: ${report.status}; Bericht: ${reportPath}`);
    if (report.errors.length) throw new Error(`${report.errors.length} Motiv(e) nicht uploadfähig. Kein R2-Upload.`);
    console.log("Kein Upload. Für den Upload denselben Befehl mit --upload ausführen.");
    return;
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  verifyPreflightReport(report, fingerprint, selected);
  console.log(`Passende Offline-Vorprüfung geladen: ${reportPath}`);
  // Before any network connection, catch every source changed since preflight.
  for (const item of selected) await verifySourceBytes(item, plan.base_dir);
  const r2 = await simpleEnv(path.join(ROOT, "r2-speicher-vergleich/.env"));
  const app = await simpleEnv(path.join(ROOT, "baurelia-designer/scripts/r2-resize/.env"));
  const account = r2.NEW_R2_ACCOUNT_ID;
  const bucket = r2.NEW_R2_BUCKET;
  const endpoint = r2.NEW_R2_ENDPOINT_URL || `https://${account}.r2.cloudflarestorage.com`;
  if (!account || !r2.NEW_R2_ACCESS_KEY_ID || !r2.NEW_R2_SECRET_ACCESS_KEY ||
      !bucket || bucket !== app.R2_BUCKET_NAME || account !== app.R2_ACCOUNT_ID ||
      r2.NEW_R2_PREFIX !== "motifs-v2/" ||
      endpoint !== `https://${account}.r2.cloudflarestorage.com` ||
      app.R2_PUBLIC_URL !== "https://media.baurelia.ch") {
    throw new Error("R2-Konfigurationen stimmen nicht überein. Kein Upload.");
  }
  const storage = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: r2.NEW_R2_ACCESS_KEY_ID,
      secretAccessKey: r2.NEW_R2_SECRET_ACCESS_KEY,
    },
    maxAttempts: 4,
  });
  const entries = [];
  for (const [index, item] of selected.entries()) {
    const prepared = await prepareItem(item, plan.base_dir);
    if (JSON.stringify(prepared.details) !== JSON.stringify(report.entries[index])) {
      throw new Error(`Bild/Varianten weichen von der Vorprüfung ab: ${item.motif_id}.`);
    }
    const keys = prepared.details.keys;
    console.log(`[${index + 1}/${selected.length}] ${item.motif_id}: ${item.source_kind}`);
    const masterHash = await putChecked(storage, bucket, keys.master, prepared.master, "image/png");
    await putChecked(storage, bucket, keys.thumbnail, prepared.variants.thumbnail, "image/webp");
    await putChecked(storage, bucket, keys.preview, prepared.variants.preview, "image/webp");
    entries.push({
      id: item.id,
      handle: item.handle,
      category_handle: item.category_handle,
      old_key: item.old_key,
      old_updated_at: item.old_updated_at,
      new_key: keys.master,
      sha256: masterHash,
      content_length: prepared.master.length,
      variants: {
        thumbnail: {
          sha256: prepared.details.variants.thumbnail.sha256,
          content_length: prepared.details.variants.thumbnail.bytes,
        },
        preview: {
          sha256: prepared.details.variants.preview.sha256,
          content_length: prepared.details.variants.preview.bytes,
        },
      },
      source_kind: item.source_kind,
      motif_id: item.motif_id,
    });
  }
  const manifest = { schema: 1, shop: SHOP, generated_at: new Date().toISOString(),
    catalog_exported_at: plan.catalog_exported_at, plan_sha256: planSha256,
    preflight_fingerprint: fingerprint, selection,
    excluded: {
      unresolved: plan.unresolved.length,
      quality_review: plan.entries.length - eligible.length,
      not_selected: eligible.length - selected.length,
    },
    entries };
  const file = path.join(OUTPUT_DIR, options.approvedOnly ? "manifest-approved-review.json" :
    options.all ? "manifest.json" : `manifest-${selected.length}.json`);
  await writeJsonAtomic(file, manifest);
  console.log(`R2-Upload und HEAD-Prüfung abgeschlossen. Importmanifest: ${file}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
