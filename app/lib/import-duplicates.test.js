import test from "node:test";
import assert from "node:assert/strict";
import {
  findImportDuplicates,
  selectImportDuplicates,
} from "./import-duplicates.js";

const legacyMotifs = [
  { handle: "katze-26", slug: "katze-26", categoryHandle: "katze" },
  { handle: "katze-27", slug: "katze-27", categoryHandle: "katze" },
];

test("finds extra motifs only when their original exists in the same category", () => {
  const items = [
    { id: "1", handle: "katze-26", slug: "katze-26", category_handle: "katze" },
    { id: "2", handle: "katze-26-db0952a0-e575", slug: "katze-26", category_handle: "katze" },
    { id: "3", handle: "katze-27-214a2f72-1707", slug: "katze-27", category_handle: "katze" },
    { id: "4", handle: "hund-katze-26", slug: "katze-26", category_handle: "hund" },
  ];

  assert.deepEqual(findImportDuplicates(items, legacyMotifs, "motifs"), [
    "katze-26-db0952a0-e575",
  ]);
});

test("does not classify a replacement as duplicate when the original was removed", () => {
  const items = [
    { id: "2", handle: "katze-26-db0952a0-e575", slug: "katze-26", category_handle: "katze" },
  ];
  assert.deepEqual(findImportDuplicates(items, legacyMotifs, "motifs"), []);
});

test("selects only the exact currently verified handles", () => {
  const current = {
    categories: [],
    motifs: ["katze-26-db0952a0-e575", "katze-27-214a2f72-1707"],
  };
  assert.deepEqual(
    selectImportDuplicates(
      { categories: [], motifs: ["katze-26-db0952a0-e575"] },
      current,
    ),
    { categories: [], motifs: ["katze-26-db0952a0-e575"] },
  );
  assert.throws(
    () => selectImportDuplicates({ categories: [], motifs: ["other"] }, current),
    /geändert/,
  );
  assert.throws(
    () => selectImportDuplicates({ categories: [], motifs: [] }, current),
    /keine Duplikate/,
  );
});
