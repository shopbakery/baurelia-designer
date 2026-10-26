const byStoredOrder = (left, right) =>
  Number(left.sort_order || 0) - Number(right.sort_order || 0) ||
  String(left.name || left.displayName).localeCompare(
    String(right.name || right.displayName),
    "de",
  );

export function planActiveMotifMove(motifs, handle, targetPosition) {
  const ordered = [...motifs].sort(byStoredOrder);
  const activeSlots = ordered.flatMap((motif, index) =>
    motif.active === false ? [] : [index],
  );
  const activeMotifs = activeSlots.map((index) => ordered[index]);
  const sourceIndex = activeMotifs.findIndex((motif) => motif.handle === handle);

  if (sourceIndex < 0) {
    throw new Error("Das aktive Motiv wurde in dieser Kategorie nicht gefunden.");
  }
  if (
    !Number.isSafeInteger(targetPosition) ||
    targetPosition < 1 ||
    targetPosition > activeMotifs.length
  ) {
    throw new Error(`Bitte wähle eine Position zwischen 1 und ${activeMotifs.length}.`);
  }

  if (sourceIndex === targetPosition - 1) {
    return {
      currentPosition: targetPosition,
      targetPosition,
      ordered,
      updates: [],
    };
  }

  const [moved] = activeMotifs.splice(sourceIndex, 1);
  activeMotifs.splice(targetPosition - 1, 0, moved);

  const reordered = [...ordered];
  activeSlots.forEach((slot, index) => {
    reordered[slot] = activeMotifs[index];
  });

  return {
    currentPosition: sourceIndex + 1,
    targetPosition,
    ordered: reordered,
    updates: reordered.flatMap((motif, index) =>
      Number(motif.sort_order) === index + 1
        ? []
        : [{ motif, sortOrder: index + 1 }],
    ),
  };
}
