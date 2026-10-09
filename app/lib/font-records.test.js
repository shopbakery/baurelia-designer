import test from "node:test";
import assert from "node:assert/strict";
import { assertFontAvailable, fontSlugFromName } from "./font-records.js";

test("derives the font slug from the name", () => {
  assert.equal(fontSlugFromName("  Märchen Schrift  "), "marchen-schrift");
  assert.throws(() => fontSlugFromName("✨"), /Buchstaben oder Zahlen/);
});

test("does not overwrite an existing font or reuse its CSS family", () => {
  const fonts = [
    { handle: "marchen-schrift", slug: "Märchen Schrift", font_family: "Märchen Schrift" },
    { handle: "comic", slug: "comic", font_family: "Lustig" },
  ];
  assert.throws(
    () => assertFontAvailable(fonts, "MÄRCHEN Schrift", fontSlugFromName("MÄRCHEN Schrift")),
    /existiert bereits/,
  );
  assert.throws(
    () => assertFontAvailable(fonts, "Lustig", fontSlugFromName("Lustig")),
    /existiert bereits/,
  );
  assert.doesNotThrow(() =>
    assertFontAvailable(fonts, "Neue Schrift", fontSlugFromName("Neue Schrift")),
  );
});
