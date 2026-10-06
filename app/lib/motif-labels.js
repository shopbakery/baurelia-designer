const UUID_PREFIX =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-/i;

const decodeFileName = (value) => {
  if (!value) return "";
  const withoutQuery = String(value).split(/[?#]/, 1)[0];
  const lastSegment = withoutQuery.split("/").filter(Boolean).at(-1) || "";
  try {
    return decodeURIComponent(lastSegment).replace(UUID_PREFIX, "");
  } catch {
    return lastSegment.replace(UUID_PREFIX, "");
  }
};

export const motifOriginalFilename = (motif = {}) =>
  motif.original_filename ||
  decodeFileName(motif.r2_key) ||
  decodeFileName(motif.image_url || motif.imageUrl);

export const motifDisplayLabel = (
  motif,
  categoryName,
  positionOverride = null,
) => {
  const storedPosition = Number(motif?.sort_order ?? motif?.sortOrder);
  const position =
    Number.isInteger(positionOverride) && positionOverride > 0
      ? positionOverride
      : Number.isInteger(storedPosition) && storedPosition > 0
      ? storedPosition
      : 1;
  const prefix = categoryName || motif?.category_handle || "Motiv";
  return `${prefix} ${position}`;
};
