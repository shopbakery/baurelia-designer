import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const argumentsList = process.argv.slice(2);
const applyChanges = argumentsList.includes("--apply");
const credentialsArgument = argumentsList.find((argument) =>
  argument.startsWith("--credentials="),
);

if (!credentialsArgument) {
  throw new Error("Bitte --credentials=<Pfad zur api-call-test.py> angeben.");
}

const credentialsPath = credentialsArgument.slice("--credentials=".length);
const credentialsSource = await fs.readFile(credentialsPath, "utf8");
const token = credentialsSource.match(/ACCESS_TOKEN\s*=\s*["']([^"']+)["']/)?.[1];
const shopUrl = credentialsSource.match(/SHOP_URL\s*=\s*["']([^"']+)["']/)?.[1];

if (!token || !shopUrl) {
  throw new Error("ACCESS_TOKEN oder SHOP_URL wurde nicht gefunden.");
}

const shopDomain = new URL(shopUrl).hostname;
const graphqlEndpoint = `https://${shopDomain}/admin/api/2026-07/graphql.json`;
const storefrontDomain = "https://www.baurelia.ch";
const reportPath = path.join(scriptDirectory, "product-color-migration-report.json");

const readGraphql = (filename) =>
  fs.readFile(path.join(scriptDirectory, filename), "utf8");

const [definitionsQuery, currentBulkQuery, writeMutation] = await Promise.all([
  readGraphql("product-color-migration-definitions.graphql"),
  readGraphql("product-color-migration-current-bulk.graphql"),
  readGraphql("product-color-migration-write.graphql"),
]);

async function graphql(query, variables = {}) {
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const response = await fetch(graphqlEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    });
    const payload = await response.json();
    const throttled = payload.errors?.some(
      (error) => error.extensions?.code === "THROTTLED",
    );

    if (!throttled) {
      if (!response.ok || payload.errors?.length) {
        throw new Error(JSON.stringify(payload.errors || payload));
      }
      return payload.data;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(15_000, 1000 * 2 ** attempt)),
    );
  }

  throw new Error("Shopify blieb nach mehreren Versuchen gedrosselt.");
}

const normalize = (value) =>
  String(value || "")
    .trim()
    .toLocaleLowerCase("de-CH")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");

const getValue = (metafield) => metafield?.jsonValue ?? null;
const hasValue = (metafield) => metafield != null && metafield.jsonValue != null;

const [definitionData, bulkData, bootstrapResponse] = await Promise.all([
  graphql(definitionsQuery),
  graphql(currentBulkQuery),
  fetch(`${storefrontDomain}/apps/baurelia-designer/bootstrap`),
]);

if (!bootstrapResponse.ok) {
  throw new Error(`Customizer-Bootstrap antwortete mit ${bootstrapResponse.status}.`);
}

const bootstrap = await bootstrapResponse.json();
const colors = bootstrap.colors || [];
const colorByKey = new Map();

for (const color of colors) {
  for (const key of [color.id, color.handle, color.slug, color.name]) {
    if (key) colorByKey.set(normalize(key), color);
  }
}

const expectedDefinitions = new Map([
  ["hidden_colors", "list.metaobject_reference"],
  ["default_text_color", "metaobject_reference"],
  ["default_decoration_color_1", "metaobject_reference"],
  ["default_decoration_color_2", "metaobject_reference"],
]);
const definitions = definitionData.metafieldDefinitions.nodes.filter((definition) =>
  expectedDefinitions.has(definition.key),
);

for (const [key, expectedType] of expectedDefinitions) {
  const definition = definitions.find((item) => item.key === key);
  if (!definition) throw new Error(`Definition custom.${key} fehlt.`);
  if (definition.type.name !== expectedType) {
    throw new Error(
      `Definition custom.${key} hat ${definition.type.name}, erwartet wird ${expectedType}.`,
    );
  }
}

const targetDefinitionIds = new Set(
  definitions.flatMap((definition) =>
    definition.validations
      .filter((validation) => validation.name === "metaobject_definition_id")
      .map((validation) => validation.value),
  ),
);
if (targetDefinitionIds.size !== 1) {
  throw new Error("Die vier Produktfelder verweisen nicht auf dieselbe Farbdefinition.");
}

const operation = bulkData.currentBulkOperation;
if (!operation || operation.status !== "COMPLETED" || !operation.url) {
  throw new Error("Es ist keine abgeschlossene Produkt-Bulk-Inventur verfügbar.");
}

const bulkResponse = await fetch(operation.url);
if (!bulkResponse.ok) {
  throw new Error(`Bulk-Ergebnis antwortete mit ${bulkResponse.status}.`);
}

const jsonLines = (await bulkResponse.text())
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const products = jsonLines.filter((entry) => entry.id?.startsWith("gid://shopify/Product/"));
const plans = [];
const unresolved = [];

function resolveColor(value, product, sourceKey) {
  const color = colorByKey.get(normalize(value));
  if (!color) {
    unresolved.push({
      productId: product.id,
      title: product.title,
      handle: product.handle,
      sourceKey,
      value,
    });
  }
  return color || null;
}

for (const product of products) {
  const legacyHidden = getValue(product.legacyHiddenColors);
  const legacyText = getValue(product.legacyDefaultTextColor);
  const legacyDecoration2 = getValue(product.legacyDefaultDecorationColor2);
  const hasLegacy = legacyHidden != null || legacyText != null || legacyDecoration2 != null;
  if (!hasLegacy) continue;

  const writes = [];
  const planned = {};

  if (legacyHidden != null && !hasValue(product.hiddenColors)) {
    const hiddenValues = Array.isArray(legacyHidden)
      ? legacyHidden
      : [legacyHidden].filter(Boolean);
    const resolved = hiddenValues
      .map((value) => resolveColor(value, product, "farben_ausblenden"))
      .filter(Boolean);
    if (resolved.length === hiddenValues.length) {
      const ids = [...new Set(resolved.map((color) => color.id))];
      planned.hidden_colors = resolved.map(({ id, name, slug }) => ({ id, name, slug }));
      writes.push({
        ownerId: product.id,
        namespace: "custom",
        key: "hidden_colors",
        type: "list.metaobject_reference",
        value: JSON.stringify(ids),
      });
    }
  }

  if (legacyText != null) {
    const textColor = resolveColor(legacyText, product, "default_text_farbe");
    if (textColor) {
      if (!hasValue(product.defaultTextColor)) {
        planned.default_text_color = textColor;
        writes.push({
          ownerId: product.id,
          namespace: "custom",
          key: "default_text_color",
          type: "metaobject_reference",
          value: textColor.id,
        });
      }
      if (!hasValue(product.defaultDecorationColor1)) {
        planned.default_decoration_color_1 = textColor;
        writes.push({
          ownerId: product.id,
          namespace: "custom",
          key: "default_decoration_color_1",
          type: "metaobject_reference",
          value: textColor.id,
        });
      }
    }
  }

  if (legacyDecoration2 != null && !hasValue(product.defaultDecorationColor2)) {
    const decoration2Color = resolveColor(
      legacyDecoration2,
      product,
      "default_deko_2_farbe",
    );
    if (decoration2Color) {
      planned.default_decoration_color_2 = decoration2Color;
      writes.push({
        ownerId: product.id,
        namespace: "custom",
        key: "default_decoration_color_2",
        type: "metaobject_reference",
        value: decoration2Color.id,
      });
    }
  }

  plans.push({
    productId: product.id,
    title: product.title,
    handle: product.handle,
    legacy: {
      farben_ausblenden: legacyHidden,
      default_text_farbe: legacyText,
      default_deko_2_farbe: legacyDecoration2,
    },
    planned,
    writes,
  });
}

const writes = plans.flatMap((plan) => plan.writes);
const report = {
  generatedAt: new Date().toISOString(),
  shop: shopDomain,
  mode: applyChanges ? "apply" : "dry-run",
  definitions: Object.fromEntries(
    definitions.map((definition) => [definition.key, definition.type.name]),
  ),
  colorCount: colors.length,
  totalProducts: products.length,
  productsWithLegacyValues: plans.length,
  productsWithPlannedWrites: plans.filter((plan) => plan.writes.length).length,
  plannedWrites: writes.length,
  unresolved,
  products: plans.map(({ writes: ignored, ...plan }) => plan),
};

if (applyChanges) {
  if (unresolved.length) {
    throw new Error(
      `${unresolved.length} Altwerte konnten nicht aufgelöst werden. Migration abgebrochen.`,
    );
  }

  for (let index = 0; index < writes.length; index += 25) {
    const batch = writes.slice(index, index + 25);
    const data = await graphql(writeMutation, { metafields: batch });
    const errors = data.metafieldsSet.userErrors || [];
    if (errors.length) {
      throw new Error(`Metafield-Batch fehlgeschlagen: ${JSON.stringify(errors)}`);
    }
  }
}

await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      reportPath,
      mode: report.mode,
      colorCount: report.colorCount,
      totalProducts: report.totalProducts,
      productsWithLegacyValues: report.productsWithLegacyValues,
      productsWithPlannedWrites: report.productsWithPlannedWrites,
      plannedWrites: report.plannedWrites,
      unresolvedCount: report.unresolved.length,
    },
    null,
    2,
  ),
);
