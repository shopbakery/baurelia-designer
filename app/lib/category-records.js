import { slugFromName } from "./resource-slug.js";

export const categorySlugFromName = (name) => {
  const slug = slugFromName(name);

  if (!slug) {
    throw new Error("Der Kategoriename muss Buchstaben oder Zahlen enthalten.");
  }
  return slug;
};

export const assertCategorySlugAvailable = (categories, slug) => {
  if (
    categories.some(
      (category) =>
        categorySlugFromName(category.handle) === slug ||
        categorySlugFromName(category.slug || category.handle) === slug,
    )
  ) {
    throw new Error("Eine Kategorie mit diesem Namen existiert bereits.");
  }
};
