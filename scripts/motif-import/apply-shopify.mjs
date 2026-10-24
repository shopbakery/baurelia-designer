import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const DEFAULT_PLAN = path.join(ROOT, "r2-speicher-vergleich/outputs/motif-import/plan.json");
const SHOP = "3f14b7-2.myshopify.com";
const API_VERSION = "2026-07";
const PUBLIC_URL = "https://media.baurelia.ch";
const SHA256 = /^[a-f0-9]{64}$/;
const METAOBJECT_ID = /^gid:\/\/shopify\/Metaobject\/\d+$/;

const GET_MOTIF = `#graphql
  query BaureliaOneTimeMotif($id: ID!) {
    metaobject(id: $id) {
      id
      handle
      type
      updatedAt
      fields { key jsonValue }
    }
  }
`;

const UPDATE_MOTIF = `#graphql
  mutation BaureliaOneTimeMotifUpdate(
    $id: ID!
    $metaobject: MetaobjectUpdateInput!
  ) {
    metaobjectUpdate(id: $id, metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message code }
    }
  }
`;

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function parseArgs(args) {
  const options = { apply: false, manifest: null, plan: DEFAULT_PLAN };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--apply") options.apply = true;
    else if (args[i] === "--manifest") options.manifest = args[++i];
    else if (args[i] === "--plan") options.plan = args[++i];
    else throw new Error(`Unbekannte Option: ${args[i]}`);
  }
  if (!options.manifest || !options.plan ||
      options.manifest.startsWith("--") || options.plan.startsWith("--")) {
    throw new Error("Aufruf: node apply-shopify.mjs --manifest PFAD [--plan PFAD] [--apply]");
  }
  return options;
}

export function versionedKey(item) {
  const digest = hash(Buffer.from(`${item.id}:${item.source_sha256}`, "utf8"));
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return `motifs-v2/${item.category_handle}/${uuid}-${item.motif_id}.png`;
}

function publicUrl(key) {
  return `${PUBLIC_URL}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function oldKeyFromUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    const root = new URL(`${PUBLIC_URL}/`);
    if (parsed.origin !== root.origin || !parsed.pathname.startsWith(root.pathname)) return "";
    return parsed.pathname.slice(root.pathname.length).split("/").map(decodeURIComponent).join("/");
  } catch {
    return "";
  }
}

export function targetFields(entry) {
  const relative = entry.new_key.slice("motifs-v2/".length);
  return {
    r2_key: entry.new_key,
    image_url: publicUrl(entry.new_key),
    thumbnail_url: publicUrl(`motifs-v2-thumbs/${relative}.webp`),
  };
}

export function validateManifest(manifest, plan, planBytes) {
  if (manifest?.schema !== 1 || manifest.shop !== SHOP || !Array.isArray(manifest.entries) ||
      !manifest.entries.length || !SHA256.test(manifest.plan_sha256 || "") ||
      manifest.plan_sha256 !== hash(planBytes) || plan?.schema !== 1 || plan.shop !== SHOP ||
      !Array.isArray(plan.entries) || manifest.catalog_exported_at !== plan.catalog_exported_at) {
    throw new Error("Manifest/Plan ungültig, verändert oder für einen anderen Shop.");
  }
  const byId = new Map(plan.entries.map((item) => [item.id, item]));
  const ids = new Set();
  const keys = new Set();
  for (const entry of manifest.entries) {
    const source = byId.get(entry?.id);
    if (!source || !METAOBJECT_ID.test(entry.id) || !entry.handle ||
        !/^[a-z0-9][a-z0-9-]*$/.test(entry.category_handle || "") ||
        !/^[a-z0-9][a-z0-9._-]*$/.test(entry.motif_id || "") ||
        typeof entry.old_key !== "string" || !entry.old_key ||
        typeof entry.old_updated_at !== "string" || !entry.old_updated_at ||
        !SHA256.test(entry.sha256 || "") ||
        !Number.isSafeInteger(entry.content_length) || entry.content_length <= 0 ||
        source.needs_review ||
        entry.handle !== source.handle || entry.category_handle !== source.category_handle ||
        entry.motif_id !== source.motif_id || entry.old_key !== source.old_key ||
        entry.old_updated_at !== source.old_updated_at ||
        entry.sha256 !== source.source_sha256 || entry.content_length !== source.source_bytes ||
        entry.new_key !== versionedKey(source) ||
        ids.has(entry.id) || keys.has(entry.new_key)) {
      throw new Error(`Manifest-Zuordnung oder Prüfdaten ungültig: ${entry?.motif_id || "unbekannt"}`);
    }
    ids.add(entry.id);
    keys.add(entry.new_key);
  }
  return manifest.entries;
}

export function normalizeMetaobject(node) {
  if (!node) return null;
  const fields = Object.fromEntries((node.fields || []).map((field) => [field.key, field.jsonValue]));
  return { id: node.id, handle: node.handle, type: node.type,
    updated_at: node.updatedAt, ...fields };
}

export function classifyCurrent(entry, current) {
  if (!current || current.id !== entry.id || current.handle !== entry.handle ||
      !(current.type === "$app:motif" || String(current.type).endsWith("--motif")) ||
      current.category_handle !== entry.category_handle) {
    throw new Error(`Shopify-Motiv-ID/Handle/Kategorie stimmt nicht: ${entry.handle}`);
  }
  const target = targetFields(entry);
  const storedKey = String(current.r2_key || oldKeyFromUrl(current.image_url) || "");
  if (storedKey === entry.new_key) {
    if (current.image_url === target.image_url && current.thumbnail_url === target.thumbnail_url) {
      return "already_done";
    }
    throw new Error(`Neuer R2-Schlüssel mit abweichenden URLs: ${entry.handle}`);
  }
  if (storedKey !== entry.old_key || current.updated_at !== entry.old_updated_at) {
    throw new Error(`Shopify-Motiv wurde seit Katalogexport geändert: ${entry.handle}`);
  }
  return "update";
}

export function verifyReadBack(entry, node) {
  const current = normalizeMetaobject(node);
  if (classifyCurrent(entry, current) !== "already_done") {
    throw new Error(`Shopify-Rückleseprüfung fehlgeschlagen: ${entry.handle}`);
  }
}

export function createAdminClient(token, fetchFn = fetch) {
  if (!token) throw new Error("SHOPIFY_ADMIN_ACCESS_TOKEN fehlt für --apply.");
  const endpoint = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;
  return async (query, variables) => {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`Shopify Admin API HTTP ${response.status}. Import gestoppt.`);
    const payload = await response.json();
    if (payload.errors?.length) {
      throw new Error(`Shopify GraphQL-Fehler: ${payload.errors.map((item) => item.message).join("; ")}`);
    }
    return payload.data;
  };
}

async function getMotif(graphql, id) {
  const data = await graphql(GET_MOTIF, { id });
  return normalizeMetaobject(data?.metaobject);
}

export async function applyEntries(entries, graphql, log = console.log) {
  const results = [];
  for (const [index, entry] of entries.entries()) {
    const before = await getMotif(graphql, entry.id);
    const decision = classifyCurrent(entry, before);
    if (decision === "update") {
      const target = targetFields(entry);
      const data = await graphql(UPDATE_MOTIF, {
        id: entry.id,
        metaobject: { fields: Object.entries(target).map(([key, value]) => ({ key, value })) },
      });
      const result = data?.metaobjectUpdate;
      if (result?.userErrors?.length) {
        throw new Error(`Shopify-Update abgelehnt: ${entry.handle}: ` +
          result.userErrors.map((item) => item.message).join("; "));
      }
      if (result?.metaobject?.id !== entry.id || result.metaobject.handle !== entry.handle) {
        throw new Error(`Shopify-Update lieferte eine andere Metaobjekt-ID: ${entry.handle}`);
      }
      const after = await graphql(GET_MOTIF, { id: entry.id });
      verifyReadBack(entry, after?.metaobject);
    }
    results.push({ motif_id: entry.motif_id, status: decision === "update" ? "updated" : decision });
    log(`[${index + 1}/${entries.length}] ${entry.motif_id}: ${results.at(-1).status}`);
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [manifestBytes, planBytes] = await Promise.all([
    readFile(path.resolve(options.manifest)), readFile(path.resolve(options.plan)),
  ]);
  const entries = validateManifest(JSON.parse(manifestBytes), JSON.parse(planBytes), planBytes);
  console.log(`${entries.length} eindeutige Motive; Shop ${SHOP}; Manifest ${hash(manifestBytes).slice(0, 12)}.`);
  if (!options.apply) {
    console.log("Trockenlauf OK: keine Netzabfrage, kein Shopify-Token, keine Änderung. Mit --apply starten.");
    return;
  }
  const graphql = createAdminClient(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN);
  const results = await applyEntries(entries, graphql);
  console.log(`Fertig: ${results.filter((item) => item.status === "updated").length} aktualisiert, ` +
    `${results.filter((item) => item.status === "already_done").length} bereits korrekt.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Gestoppt: ${error.message}`); process.exitCode = 1; });
}
