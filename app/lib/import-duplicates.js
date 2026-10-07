export const findImportDuplicates = (items, legacyItems, resource) => {
  const liveByHandle = new Map(items.map((item) => [item.handle, item]));
  const legacyHandles = new Set(legacyItems.map((item) => item.handle));
  const legacyBySlug = new Map();

  for (const legacy of legacyItems) {
    const slug = String(legacy.slug || "");
    if (!slug) continue;
    const candidates = legacyBySlug.get(slug) || [];
    candidates.push(legacy);
    legacyBySlug.set(slug, candidates);
  }

  return items
    .filter((item) => {
      if (legacyHandles.has(item.handle)) {
        return false;
      }

      return (legacyBySlug.get(String(item.slug || "")) || []).some((legacy) => {
        const original = liveByHandle.get(legacy.handle);
        if (!original || original.id === item.id) return false;
        if (String(original.slug || "") !== String(legacy.slug)) return false;

        if (resource === "motifs") {
          return (
            item.category_handle === legacy.categoryHandle &&
            original.category_handle === legacy.categoryHandle
          );
        }

        return true;
      });
    })
    .map((item) => item.handle);
};

export const selectImportDuplicates = (submitted, current) => {
  if (!submitted || typeof submitted !== "object") {
    throw new Error("Die Duplikat-Auswahl ist ungültig. Bitte lade die Seite neu.");
  }

  const selected = {};
  for (const resource of ["categories", "motifs"]) {
    const handles = submitted[resource];
    if (
      !Array.isArray(handles) ||
      handles.some((handle) => typeof handle !== "string" || !handle) ||
      new Set(handles).size !== handles.length
    ) {
      throw new Error("Die Duplikat-Auswahl ist ungültig. Bitte lade die Seite neu.");
    }
    const currentHandles = new Set(current[resource]);
    if (handles.some((handle) => !currentHandles.has(handle))) {
      throw new Error("Die Duplikat-Liste hat sich geändert. Bitte lade die Seite neu.");
    }
    selected[resource] = handles;
  }

  if (!selected.categories.length && !selected.motifs.length) {
    throw new Error("Es wurden keine Duplikate ausgewählt.");
  }
  return selected;
};
