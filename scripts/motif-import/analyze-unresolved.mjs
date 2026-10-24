import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(HERE, "../../../r2-speicher-vergleich/outputs/motif-import");
const PLAN = path.join(OUTPUT_DIR, "plan.json");
const SOURCES = path.join(OUTPUT_DIR, "sources.json");
const OUTPUT = path.join(OUTPUT_DIR, "unresolved-212-manual-review.csv");

const csvCell = (value) => {
  const text = String(value ?? "");
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const categoryAndNumber = (motifId) => {
  const match = String(motifId).match(/^(.+)-(\d+(?:\.\d+)?)$/);
  if (!match) throw new Error(`Unbekanntes Motiv-ID-Format: ${motifId}`);
  return { category: match[1], number: match[2] };
};

async function main() {
  const catalogPath = process.argv[2];
  if (!catalogPath) {
    throw new Error("Aufruf: node scripts/motif-import/analyze-unresolved.mjs <Katalogexport.json>");
  }
  const [plan, sources, catalog] = await Promise.all([
    readFile(PLAN, "utf8").then(JSON.parse),
    readFile(SOURCES, "utf8").then(JSON.parse),
    readFile(path.resolve(catalogPath), "utf8").then(JSON.parse),
  ]);
  if (plan.schema !== 1 || sources.schema !== 1 ||
      plan.shop !== catalog.shop || !Array.isArray(plan.entries) ||
      !Array.isArray(plan.unresolved) || !Array.isArray(sources.items) ||
      !Array.isArray(catalog.motifs)) {
    throw new Error("Plan, Quellen und Katalog passen nicht zusammen.");
  }

  const sourceById = new Map();
  for (const item of sources.items) {
    if (sourceById.has(item.motif_id)) throw new Error(`Doppelte Quellen-ID: ${item.motif_id}`);
    sourceById.set(item.motif_id, item);
  }
  const plannedByShopifyId = new Map();
  for (const item of plan.entries) {
    if (plannedByShopifyId.has(item.id)) throw new Error(`Doppelte Shopify-ID im Plan: ${item.id}`);
    plannedByShopifyId.set(item.id, item.motif_id);
  }

  const headers = [
    "source_motif_id", "source_path", "needs_review", "possible_shopify_handle",
    "possible_shopify_id", "catalog_slug", "catalog_original_filename",
    "candidate_already_planned_for", "reason_rule", "candidate_count",
    "candidate_handles_if_ambiguous", "manual_review_required",
  ];
  const lines = [headers.join(";")];
  const counts = new Map();
  for (const unresolved of plan.unresolved) {
    const source = sourceById.get(unresolved.motif_id);
    if (!source) throw new Error(`Quelle fehlt für ${unresolved.motif_id}`);
    const { category, number } = categoryAndNumber(unresolved.motif_id);
    let candidates = catalog.motifs.filter((motif) =>
      motif.category_handle === category &&
      String(motif.slug || "").startsWith(`${unresolved.motif_id}-`));
    let rule = "versionssuffix_gleicher_stamm";
    if (!candidates.length && category === "bauernhof") {
      candidates = catalog.motifs.filter((motif) =>
        motif.category_handle === "bauernhoftiere" &&
        motif.slug === `bauernhoftiere-${number}`);
      rule = "kategorie_alias_bauernhof_bauernhoftiere";
    }
    if (candidates.length > 1) rule = "mehrere_moegliche_kandidaten";
    if (!candidates.length) rule = "kein_kandidat_im_katalogexport";
    const candidate = candidates.length === 1 ? candidates[0] : null;
    const alreadyPlannedFor = candidate ? plannedByShopifyId.get(candidate.id) || "" : "";
    if (alreadyPlannedFor) rule += "_bereits_anders_verplant";
    counts.set(rule, (counts.get(rule) || 0) + 1);
    const row = [
      unresolved.motif_id,
      source.source_path,
      source.needs_review ? "ja" : "nein",
      candidate?.handle || "",
      candidate?.id || "",
      candidate?.slug || "",
      candidate?.original_filename || "",
      alreadyPlannedFor,
      rule,
      candidates.length,
      candidates.length > 1 ? candidates.map((item) => item.handle).join(" | ") : "",
      "ja",
    ];
    lines.push(row.map(csvCell).join(";"));
  }
  await writeFile(OUTPUT, `\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
  console.log(`Manuelle Prüfliste: ${plan.unresolved.length} Fälle, ${OUTPUT}`);
  for (const [rule, count] of counts) console.log(`${rule}: ${count}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
