// Read-only storefront smoke test. Run before publishing a theme or after an R2/CORS change.
// BAURELIA_CHECK_ORIGIN may be set to a Shopify preview origin to test its CORS rule.
const store = new URL(process.env.BAURELIA_STORE_URL || "https://www.baurelia.ch");
const origin = new URL(process.env.BAURELIA_CHECK_ORIGIN || store.origin).origin;
const proxy = new URL("/apps/baurelia-designer/", store);
const failures = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const request = async (url, options = {}) => {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok || (response.status < 500 && response.status !== 429)) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt === 0) await sleep(500);
  }
  throw lastError;
};

const mapLimited = async (items, limit, task) => {
  let next = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  }));
  return results;
};

const json = async (url) => {
  const response = await request(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
};

const bootstrap = await json(new URL("bootstrap", proxy));
const categories = (bootstrap.categories || []).filter((item) => item.active !== false);
const catalog = await mapLimited(categories, 4, async (category) => {
  try {
    const url = new URL("motifs", proxy);
    url.searchParams.set("category", category.handle);
    const data = await json(url);
    return (data.motifs || []).filter((item) => item.active !== false);
  } catch (error) {
    failures.push(`${category.handle}: Katalog ${error.message}`);
    return [];
  }
});

const motifs = catalog.flat();
const imageUrls = [...new Set(motifs.map((item) => item.image_url || item.imageUrl))];
const externalThumbnails = motifs.filter((item) => {
  const thumbnail = item.thumbnail_url || item.thumbnailUrl;
  if (!thumbnail) return false;
  try {
    return new URL(thumbnail).hostname !== "media.baurelia.ch";
  } catch {
    failures.push(`${item.handle}: ungültige Thumbnail-URL ${thumbnail}`);
    return false;
  }
}).length;

await mapLimited(imageUrls, 8, async (url) => {
  try {
    if (!url) throw new Error("Bild-URL fehlt");
    const response = await request(url, { method: "HEAD", headers: { Origin: origin } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const problems = [];
    const type = response.headers.get("content-type") || "";
    if (!type.startsWith("image/")) problems.push(`Content-Type ${type || "fehlt"}`);
    if (new URL(url).hostname === "media.baurelia.ch") {
      const allowOrigin = response.headers.get("access-control-allow-origin");
      if (allowOrigin !== origin && allowOrigin !== "*") {
        problems.push(`CORS fehlt (Access-Control-Allow-Origin: ${allowOrigin || "leer"})`);
      }
    }
    if (problems.length) throw new Error(problems.join("; "));
  } catch (error) {
    failures.push(`${url || "<leer>"}: ${error.message}`);
  }
});

console.log(`Origin: ${origin}`);
console.log(`Kategorien: ${categories.length}, Motive: ${motifs.length}, eindeutige Bilder: ${imageUrls.length}`);
console.log(`Thumbnails mit externem Bilddienst: ${externalThumbnails}`);
console.log(`Fehler: ${failures.length}`);
const counts = {
  missing: failures.filter((item) => item.includes("HTTP 404")).length,
  mimeType: failures.filter((item) => item.includes("Content-Type ")).length,
  cors: failures.filter((item) => item.includes("CORS fehlt")).length,
};
console.log(`Davon HTTP 404: ${counts.missing}, falscher Dateityp: ${counts.mimeType}, CORS: ${counts.cors}`);
for (const failure of failures.slice(0, 30)) console.error(`- ${failure}`);
if (failures.length > 30) console.error(`... und ${failures.length - 30} weitere Fehler`);
if (failures.length) process.exitCode = 1;
