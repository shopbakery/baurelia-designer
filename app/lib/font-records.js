import { slugFromName } from "./resource-slug.js";

export const fontSlugFromName = (name) => {
  const slug = slugFromName(name);
  if (!slug) {
    throw new Error("Der Schriftname muss Buchstaben oder Zahlen enthalten.");
  }
  return slug;
};

export const assertFontAvailable = (fonts, name, slug) => {
  const normalizedName = name.trim().toLocaleLowerCase();
  if (
    fonts.some(
      (font) =>
        slugFromName(font.handle) === slug ||
        slugFromName(font.slug || font.handle) === slug ||
        String(font.font_family || "").trim().toLocaleLowerCase() === normalizedName,
    )
  ) {
    throw new Error("Eine Schrift mit diesem Namen existiert bereits.");
  }
};
