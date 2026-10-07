const normalizedIdentity = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

const motifOrder = (motif) => Number(motif.sort_order ?? motif.sortOrder ?? 0);

const motifImageUrl = (motif) =>
  String(motif.image_url || motif.imageUrl || "").trim();

export const slugifyMotif = (value) =>
  normalizedIdentity(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const motifSlugFromFileName = (fileName) =>
  slugifyMotif(
    String(fileName || "")
      .replace(/\.[^.]+$/, "")
      .replace(/@\d+x$/i, ""),
  );

export const motifNameFromFileName = (fileName) =>
  String(fileName || "")
    .replace(/\.[^.]+$/, "")
    .replace(/@\d+x$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

export const findDuplicateMotif = (motifs, slug) => {
  const identity = normalizedIdentity(slug);
  return motifs.find(
    (motif) => normalizedIdentity(motif.slug || motif.handle) === identity,
  );
};

export const findMotifByStorageKey = (motifs, storageKey) =>
  motifs.find((motif) => motif.r2_key === storageKey);

export const isMotifUploadKeyForCategory = (key, categoryHandle) =>
  /^[a-z0-9][a-z0-9-]*$/.test(categoryHandle) &&
  String(key).split("/")[1] === categoryHandle &&
  /^motifs(?:-v2)?\/[a-z0-9][a-z0-9-]*\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-[a-z0-9._-]+$/.test(key);

export const deduplicateMotifs = (motifs) => {
  const seenSlugs = new Set();
  const seenImages = new Set();

  return [...motifs]
    .sort(
      (left, right) =>
        motifOrder(left) - motifOrder(right) ||
        String(
          left.name || left.displayName || left.handle || "",
        ).localeCompare(
          String(right.name || right.displayName || right.handle || ""),
          "de",
          { numeric: true, sensitivity: "base" },
        ),
    )
    .filter((motif) => {
      const slug = normalizedIdentity(motif.slug || motif.handle);
      const imageUrl = motifImageUrl(motif);
      if (
        (slug && seenSlugs.has(slug)) ||
        (imageUrl && seenImages.has(imageUrl))
      ) {
        return false;
      }
      if (slug) seenSlugs.add(slug);
      if (imageUrl) seenImages.add(imageUrl);
      return true;
    });
};

export const findSharedMotifReferences = (
  motifs,
  motifId,
  storageKey,
  storageKeyForMotif,
) =>
  motifs.filter(
    (motif) => motif.id !== motifId && storageKeyForMotif(motif) === storageKey,
  );
