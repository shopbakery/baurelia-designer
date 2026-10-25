export const MIN_VISIBLE_LONG_EDGE_PX = 1500;
export const MAX_MASTER_SIDE_PX = 2000;
export const MAX_INPUT_PIXELS = 40_000_000;
export const VISIBLE_ALPHA_THRESHOLD = 16;

export function resizedMotifDimensions(width, height) {
  const scale = Math.min(1, MAX_MASTER_SIDE_PX / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function visibleMotifBounds(rgba, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || rgba.length !== width * height * 4) {
    throw new Error("Die Bilddaten konnten nicht geprüft werden.");
  }

  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] < VISIBLE_ALPHA_THRESHOLD) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right < left
    ? { width: 0, height: 0 }
    : { width: right - left + 1, height: bottom - top + 1 };
}

export function motifResolutionMessage(visibleWidth, visibleHeight) {
  const longest = Math.max(visibleWidth, visibleHeight);
  if (longest >= MIN_VISIBLE_LONG_EDGE_PX) return "";
  return longest === 0
    ? "Das Motiv ist vollständig transparent und kann nicht gedruckt werden."
    : `Sichtbares Motiv nur ${longest} px; mindestens ${MIN_VISIBLE_LONG_EDGE_PX} px nötig.`;
}
