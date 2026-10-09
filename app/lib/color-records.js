import { slugFromName } from "./resource-slug.js";

export const colorSlugFromName = (name) => {
  const slug = slugFromName(name);
  if (!slug) {
    throw new Error("Der Farbname muss Buchstaben oder Zahlen enthalten.");
  }
  return slug;
};

export const assertColorSlugAvailable = (colors, slug) => {
  if (
    colors.some(
      (color) =>
        slugFromName(color.handle) === slug ||
        slugFromName(color.slug || color.handle) === slug,
    )
  ) {
    throw new Error("Eine Farbe mit diesem Namen existiert bereits.");
  }
};
