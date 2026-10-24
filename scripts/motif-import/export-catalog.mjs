import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHOP = "3f14b7-2.myshopify.com";
const BASE_URL = `https://${SHOP}/apps/baurelia-designer`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(HERE, "../../../r2-speicher-vergleich/outputs/motif-import");

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function getJson(url) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (attempt === 4) throw new Error(`Shopify-Proxy nicht erreichbar: ${url.pathname}`, { cause: error });
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    if (!response.ok) throw new Error(`Shopify-Proxy ${url.pathname}: HTTP ${response.status}`);
    if (!(response.headers.get("content-type") || "").includes("application/json")) {
      throw new Error(`Shopify-Proxy ${url.pathname} lieferte kein JSON.`);
    }
    return response.json();
  }
  throw new Error(`Shopify-Proxy nicht erreichbar: ${url.pathname}`);
}

async function main() {
  const bootstrap = await getJson(new URL(`${BASE_URL}/bootstrap`));
  if (bootstrap.source !== "shopify" || !Array.isArray(bootstrap.categories)) {
    throw new Error("Kein aktueller Shopify-Katalog: Bootstrap lieferte Legacy-Daten.");
  }
  const categories = bootstrap.categories.map((item) => item.handle);
  if (!categories.length || new Set(categories).size !== categories.length ||
      categories.some((handle) => !/^[a-z0-9][a-z0-9-]*$/.test(handle))) {
    throw new Error("Shopify-Kategorien sind leer, doppelt oder ungültig.");
  }

  const motifs = [];
  const seenIds = new Set();
  const seenHandles = new Set();
  for (const [index, category] of categories.entries()) {
    const url = new URL(`${BASE_URL}/motifs`);
    url.searchParams.set("category", category);
    const page = await getJson(url);
    if (page.source !== "shopify" || !Array.isArray(page.motifs)) {
      throw new Error(`Kategorie ${category} lieferte keinen aktuellen Shopify-Katalog.`);
    }
    for (const motif of page.motifs) {
      if (!motif.id?.startsWith("gid://shopify/Metaobject/") || !motif.handle ||
          !motif.updatedAt || motif.category_handle !== category ||
          seenIds.has(motif.id) || seenHandles.has(motif.handle)) {
        throw new Error(`Ungültiges oder doppeltes Metaobjekt in ${category}: ${motif.handle || "?"}`);
      }
      seenIds.add(motif.id);
      seenHandles.add(motif.handle);
      motifs.push({
        id: motif.id,
        handle: motif.handle,
        updated_at: motif.updatedAt,
        category_handle: motif.category_handle,
        slug: motif.slug,
        original_filename: motif.original_filename,
        r2_key: motif.r2_key,
        image_url: motif.image_url,
        active: motif.active,
      });
    }
    console.log(`[${index + 1}/${categories.length}] ${category}: ${page.motifs.length}`);
  }

  const catalog = {
    schema: 1,
    shop: SHOP,
    source: "existing_store_app_proxy",
    scope: "active_categories_and_verified_active_motifs",
    exported_at: new Date().toISOString(),
    category_count: categories.length,
    motifs,
  };
  await mkdir(OUTPUT_DIR, { recursive: true });
  const stamp = catalog.exported_at.replace(/[-:]/g, "").replace(/\..+/, "Z");
  const destination = path.join(OUTPUT_DIR, `catalog-${stamp}.json`);
  await writeFile(destination, `${JSON.stringify(catalog, null, 2)}\n`, { flag: "wx" });
  console.log(`Shopify-Katalog: ${motifs.length} Motive, ${categories.length} Kategorien.`);
  console.log(`Datei: ${destination}`);
  console.log("Hinweis: Der vorhandene Proxy zeigt nur aktive, verifizierte Motive in aktiven Kategorien.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
