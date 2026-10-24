import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import migratedMotifKeys from "../../app/data/motif-v2-map.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const SOURCES = path.join(ROOT, "r2-speicher-vergleich/outputs/motif-import/sources.json");
const OUTPUT = path.join(ROOT, "r2-speicher-vergleich/outputs/motif-import/plan.json");
const SHOP = "3f14b7-2.myshopify.com";
const UUID_PREFIX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-/i;

export const identity = (value) => String(value || "")
  .split(/[?#]/, 1)[0]
  .split("/").at(-1)
  .replace(UUID_PREFIX, "")
  .replace(/\.(?:png|jpe?g|webp)$/i, "")
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[ _]+/g, "-")
  .replace(/\.+$/, "")
  .replace(/-+/g, "-");

export const categoryFromId = (motifId) => {
  const match = String(motifId).match(/^(.+)-\d+(?:\.\d+)?$/);
  return match?.[1] || "";
};

export function buildPlan(sources, catalog, overrides = {}) {
  if (sources.schema !== 1 || !Array.isArray(sources.items)) throw new Error("Quellinventar ungültig.");
  if (catalog.shop !== SHOP || !Array.isArray(catalog.motifs)) throw new Error("Falscher Shopify-Katalog.");
  const usedIds = new Set();
  const entries = [];
  const unresolved = [];
  for (const source of sources.items) {
    const expectedCategory = source.old_r2_key?.split("/")[1] || categoryFromId(source.motif_id);
    let candidates;
    let method;
    if (overrides[source.motif_id]) {
      candidates = catalog.motifs.filter((motif) => motif.handle === overrides[source.motif_id]);
      method = "manual_override";
    } else if (source.old_r2_key) {
      candidates = catalog.motifs.filter((motif) =>
        motif.r2_key === source.old_r2_key ||
        migratedMotifKeys[motif.r2_key] === source.old_r2_key);
      method = "r2_key";
    } else {
      const wanted = identity(source.motif_id);
      candidates = catalog.motifs.filter((motif) =>
        motif.category_handle === expectedCategory &&
        [motif.slug, motif.original_filename, motif.r2_key].some((field) => identity(field) === wanted));
      method = "category_and_name";
    }
    if (candidates.length !== 1) {
      unresolved.push({ motif_id: source.motif_id, source_kind: source.source_kind,
        reason: candidates.length ? "mehrdeutig" : "kein_shopify_treffer",
        candidate_handles: candidates.map((item) => item.handle) });
      continue;
    }
    const motif = candidates[0];
    if (motif.category_handle !== expectedCategory || usedIds.has(motif.id) || !motif.r2_key) {
      unresolved.push({ motif_id: source.motif_id, source_kind: source.source_kind,
        reason: "kategorie_oder_doppelzuordnung", candidate_handles: [motif.handle] });
      continue;
    }
    usedIds.add(motif.id);
    entries.push({
      ...source,
      id: motif.id,
      handle: motif.handle,
      category_handle: motif.category_handle,
      old_key: motif.r2_key,
      old_updated_at: motif.updated_at,
      match_method: method,
    });
  }
  return {
    schema: 1,
    shop: SHOP,
    catalog_exported_at: catalog.exported_at,
    base_dir: sources.base_dir,
    entries,
    unresolved,
  };
}

async function main() {
  const catalogPath = process.argv[2];
  if (!catalogPath) throw new Error("Aufruf: node scripts/motif-import/plan.mjs <Shopify-Katalog.json> [Zuordnungen.json]");
  const sources = JSON.parse(await readFile(SOURCES, "utf8"));
  const catalog = JSON.parse(await readFile(path.resolve(catalogPath), "utf8"));
  const overrides = process.argv[3]
    ? JSON.parse(await readFile(path.resolve(process.argv[3]), "utf8"))
    : {};
  if (!overrides || Array.isArray(overrides) || typeof overrides !== "object") {
    throw new Error("Manuelle Zuordnungen müssen ein JSON-Objekt sein.");
  }
  const sourceIds = new Set(sources.items.map((item) => item.motif_id));
  for (const motifId of Object.keys(overrides)) {
    if (!sourceIds.has(motifId)) throw new Error(`Unbekannte Motiv-ID in Zuordnungen: ${motifId}`);
  }
  const plan = buildPlan(sources, catalog, overrides);
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  const review = plan.entries.filter((item) => item.needs_review).length;
  console.log(`Zugeordnet: ${plan.entries.length}; offen: ${plan.unresolved.length}; Qualitätsprüfung: ${review}`);
  console.log(`Plan: ${OUTPUT}`);
  if (plan.unresolved.length) console.log("Ungeklärte Zuordnungen bleiben vom Import ausgeschlossen.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
