import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCategorySlugAvailable,
  categorySlugFromName,
} from "./category-records.js";

test("derives a stable category slug from the entered name", () => {
  assert.equal(categorySlugFromName("  Bär & Co.  "), "bar-co");
  assert.equal(categorySlugFromName("Zahnfee 2"), "zahnfee-2");
  assert.throws(() => categorySlugFromName("✨"), /Buchstaben oder Zahlen/);
});

test("rejects a name that would overwrite an existing category", () => {
  const categories = [{ handle: "bar-co", slug: "bar-co" }];
  assert.throws(
    () => assertCategorySlugAvailable(categories, categorySlugFromName("Bär & Co")),
    /existiert bereits/,
  );
  assert.doesNotThrow(() =>
    assertCategorySlugAvailable(categories, categorySlugFromName("Zahnfee")),
  );
});
