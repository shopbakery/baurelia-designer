import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(appRoot, "..", "..");
const themeRoot = path.join(workspaceRoot, "theme");
const legacySourceRoot = path.join(appRoot, "scripts", "legacy-source", "snippets");

const decodeHtml = (value) => value.replaceAll("&amp;", "&");
const slugify = (value) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const normalizeHex = (value) =>
  /^#[0-9a-f]{3}$/i.test(value)
    ? `#${value
        .slice(1)
        .split("")
        .map((character) => character.repeat(2))
        .join("")}`
    : value;

const motifFiles = Array.from({ length: 6 }, (_, index) =>
  path.join(themeRoot, "snippets", `mw-motive-${index + 1}.liquid`),
);

const categories = [];
const motifs = [];

const originalFilename = (url) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").at(-1) || "");
  } catch {
    return "";
  }
};

for (const motifFile of motifFiles) {
  const source = await readFile(motifFile, "utf8");
  const categoryPattern = /<div class="image-swatch-wrapper" id="([^"]+)">([\s\S]*?)(?=<div class="image-swatch-wrapper" id="|$)/g;
  let categoryMatch;

  while ((categoryMatch = categoryPattern.exec(source))) {
    const categoryName = decodeHtml(categoryMatch[1]);
    const categoryHandle = slugify(categoryName);
    const categoryOrder = categories.length + 1;

    categories.push({
      handle: categoryHandle,
      name: categoryName,
      slug: categoryHandle,
      description: "",
      sortOrder: categoryOrder,
      active: true,
    });

    const itemPattern = /<input(?=[^>]*name="properties\[Motiv\]")(?=[^>]*value="([^"]+)")(?=[^>]*data-image="([^"]+)")[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"[^>]*>[\s\S]*?<span class="note-txt">([^<]+)<\/span>/g;
    let itemMatch;
    let sortOrder = 0;

    while ((itemMatch = itemPattern.exec(categoryMatch[2]))) {
      sortOrder += 1;
      const imageUrl = decodeHtml(itemMatch[2]);
      motifs.push({
        handle: slugify(itemMatch[1]),
        name: decodeHtml(itemMatch[4].trim()),
        slug: itemMatch[1],
        categoryHandle,
        imageUrl,
        thumbnailUrl: decodeHtml(itemMatch[3]),
        originalFilename: originalFilename(imageUrl),
        altText: decodeHtml(itemMatch[4].trim()),
        sortOrder,
        active: true,
      });
    }
  }
}

const colorSource = await readFile(
  path.join(legacySourceRoot, "mw-text-farb-swatches-new.liquid"),
  "utf8",
);
const colors = [];
const seenColors = new Set();
const colorPattern = /<input(?=[^>]*name="properties\[Schriftfarbe\]")(?=[^>]*value="([^"]+)")(?=[^>]*data-color="([^"]+)")[^>]*>/g;
let colorMatch;

while ((colorMatch = colorPattern.exec(colorSource))) {
  const slug = decodeHtml(colorMatch[1]);
  if (seenColors.has(slug)) continue;
  seenColors.add(slug);
  colors.push({
    handle: slugify(slug),
    name: slug.charAt(0).toUpperCase() + slug.slice(1),
    slug,
    hexValue: normalizeHex(colorMatch[2]),
    sortOrder: colors.length + 1,
    active: true,
  });
}

const fontSource = await readFile(
  path.join(legacySourceRoot, "mw-text-selection.liquid"),
  "utf8",
);
const cssSource = await readFile(path.join(themeRoot, "assets", "main.css"), "utf8");
const fontUrls = new Map();
const fontFacePattern = /@font-face\s*{[\s\S]*?font-family:\s*'([^']+)'[\s\S]*?src:\s*url\('([^']+)'\)[\s\S]*?}/g;
let fontFaceMatch;

while ((fontFaceMatch = fontFacePattern.exec(cssSource))) {
  fontUrls.set(fontFaceMatch[1], fontFaceMatch[2]);
}

const fonts = [];
const seenFonts = new Set();
const fontPattern = /<input(?=[^>]*name="properties\[Schriftart\]")(?=[^>]*value="([^"]+)")(?=[^>]*font-size="([^"]+)")(?=[^>]*data-value="([^"]+)")[^>]*>/g;
let fontMatch;

while ((fontMatch = fontPattern.exec(fontSource))) {
  const slug = fontMatch[1];
  if (seenFonts.has(slug)) continue;
  seenFonts.add(slug);
  const fontFamily = fontMatch[3];
  fonts.push({
    handle: slugify(slug),
    name: `Schriftart ${slug.replace(/\D/g, "")}`,
    slug,
    fontFamily,
    fontUrl: fontUrls.get(fontFamily) || "",
    previewText: "Wunschtext",
    scale: Number(fontMatch[2]),
    sortOrder: fonts.length + 1,
    active: true,
  });
}

const output = {
  generatedAt: new Date().toISOString(),
  categories,
  motifs,
  colors,
  fonts,
};

const outputDirectory = path.join(appRoot, "app", "data");
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  path.join(outputDirectory, "legacy-catalog.json"),
  `${JSON.stringify(output, null, 2)}\n`,
  "utf8",
);

console.log(
  JSON.stringify({
    categories: categories.length,
    motifs: motifs.length,
    colors: colors.length,
    fonts: fonts.length,
  }),
);
