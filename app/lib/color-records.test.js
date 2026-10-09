import test from "node:test";
import assert from "node:assert/strict";
import {
  assertColorSlugAvailable,
  colorSlugFromName,
} from "./color-records.js";

test("derives the color slug from the name", () => {
  assert.equal(colorSlugFromName("  Dunkelgrün  "), "dunkelgrun");
  assert.equal(colorSlugFromName("Rosa / Gold"), "rosa-gold");
  assert.throws(() => colorSlugFromName("✨"), /Buchstaben oder Zahlen/);
});

test("does not overwrite an existing color with the same generated slug", () => {
  const colors = [
    { handle: "dunkelgrun", slug: "dunkelgrün" },
    { handle: "orange", slug: "Orange" },
  ];
  assert.throws(
    () => assertColorSlugAvailable(colors, colorSlugFromName("Dunkelgrün")),
    /existiert bereits/,
  );
  assert.throws(
    () => assertColorSlugAvailable(colors, colorSlugFromName("Orange")),
    /existiert bereits/,
  );
  assert.doesNotThrow(() =>
    assertColorSlugAvailable(colors, colorSlugFromName("Rosa / Gold")),
  );
});
