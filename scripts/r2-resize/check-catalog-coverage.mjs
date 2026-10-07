// Read-only check: every active storefront motif must have a verified v2 object.
import migratedMotifKeys from "../../app/data/motif-v2-map.js";

const store = new URL(process.env.BAURELIA_STORE_URL || "https://www.baurelia.ch");
const proxy = new URL("/apps/baurelia-designer/", store);
const media = new URL(process.env.BAURELIA_MEDIA_URL || "https://media.baurelia.ch/");
const origin = new URL(process.env.BAURELIA_CHECK_ORIGIN || store.origin).origin;
const verifyTargets = process.argv.includes("--verify-targets");

const getJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
};

const bootstrap = await getJson(new URL("bootstrap", proxy));
const categories = (bootstrap.categories || []).filter((item) => item.active !== false);
const missing = [];
const targetKeys = new Set();
let count = 0;
let alreadyV2 = 0;

for (const category of categories) {
  const url = new URL("motifs", proxy);
  url.searchParams.set("category", category.handle);
  const result = await getJson(url);
  for (const motif of (result.motifs || []).filter((item) => item.active !== false)) {
    count += 1;
    const imageUrl = motif.image_url || motif.imageUrl;
    try {
      const parsed = new URL(imageUrl);
      const key = parsed.pathname.slice(1).split("/").map(decodeURIComponent).join("/");
      if (key.startsWith("motifs-v2/")) {
        alreadyV2 += 1;
        targetKeys.add(key);
      } else if (!migratedMotifKeys[key]) {
        missing.push(`${category.handle}/${motif.handle || motif.name}: ${key}`);
      } else {
        targetKeys.add(migratedMotifKeys[key]);
      }
    } catch {
      missing.push(`${category.handle}/${motif.handle || motif.name}: ungültige Bild-URL ${imageUrl}`);
    }
  }
}

console.log(`Aktive Kategorien: ${categories.length}`);
console.log(`Aktive Motive: ${count}; bereits v2: ${alreadyV2}; im Migrationsbericht: ${count - alreadyV2 - missing.length}`);
console.log(`Ohne verifizierte v2-Zuordnung: ${missing.length}`);
for (const item of missing.slice(0, 30)) console.error(`- ${item}`);
if (missing.length > 30) console.error(`... und ${missing.length - 30} weitere`);

if (verifyTargets) {
  const keys = [...targetKeys];
  const failures = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(12, keys.length) }, async () => {
    while (next < keys.length) {
      const key = keys[next++];
      const url = new URL(key.split("/").map(encodeURIComponent).join("/"), media);
      try {
        const response = await fetch(url, {
          method: "HEAD",
          headers: { Origin: origin },
          signal: AbortSignal.timeout(15000),
        });
        const type = response.headers.get("content-type") || "";
        const allow = response.headers.get("access-control-allow-origin");
        if (!response.ok || !type.startsWith("image/") || (allow !== origin && allow !== "*")) {
          failures.push(`${key}: HTTP ${response.status}, Typ ${type || "leer"}, CORS ${allow || "leer"}`);
        }
      } catch (error) {
        failures.push(`${key}: ${error.message}`);
      }
    }
  }));
  console.log(`Geprüfte v2-URLs: ${keys.length}; HTTP-/MIME-/CORS-Fehler: ${failures.length}`);
  for (const item of failures.slice(0, 30)) console.error(`- ${item}`);
  if (failures.length > 30) console.error(`... und ${failures.length - 30} weitere`);
  if (failures.length) process.exitCode = 1;
}

if (missing.length) process.exitCode = 1;
