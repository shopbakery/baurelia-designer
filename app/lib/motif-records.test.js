import test from "node:test";
import assert from "node:assert/strict";
import {
  deduplicateMotifs,
  findDuplicateMotif,
  findMotifByStorageKey,
  findSharedMotifReferences,
  isMotifUploadKeyForCategory,
  motifNameFromFileName,
  motifSlugFromFileName,
  slugifyMotif,
} from "./motif-records.js";

test("normalizes motif slugs and filenames", () => {
  assert.equal(slugifyMotif("Kätzchen 26"), "katzchen-26");
  assert.equal(motifSlugFromFileName("Katze_26@4x.PNG"), "katze-26");
  assert.equal(motifNameFromFileName("Katze_26@4x.PNG"), "Katze 26");
});

test("finds a duplicate slug independent of case", () => {
  const motifs = [{ handle: "katze-26-a", slug: "Katze-26" }];
  assert.equal(findDuplicateMotif(motifs, "katze-26"), motifs[0]);
});

test("keeps the first ordered motif for duplicate slugs or image URLs", () => {
  const motifs = [
    {
      handle: "four",
      slug: "bauernhof-4",
      image_url: "https://r2.test/shared.png",
      sort_order: 4,
    },
    {
      handle: "two-copy",
      slug: "bauernhof-2",
      image_url: "https://r2.test/other.png",
      sort_order: 3,
    },
    {
      handle: "two",
      slug: "bauernhof-2",
      image_url: "https://r2.test/shared.png",
      sort_order: 2,
    },
    {
      handle: "five",
      slug: "bauernhof-5",
      image_url: "https://r2.test/five.png",
      sort_order: 5,
    },
  ];

  assert.deepEqual(
    deduplicateMotifs(motifs).map((motif) => motif.handle),
    ["two", "five"],
  );
  assert.equal(motifs[0].handle, "four");
});

test("supports legacy motif field names", () => {
  const motifs = [
    {
      handle: "one",
      slug: "reh-1",
      imageUrl: "https://r2.test/reh.png",
      sortOrder: 1,
    },
    {
      handle: "two",
      slug: "reh-2",
      imageUrl: "https://r2.test/reh.png",
      sortOrder: 2,
    },
  ];
  assert.deepEqual(
    deduplicateMotifs(motifs).map((motif) => motif.handle),
    ["one"],
  );
});

test("finds only other references to the same storage key", () => {
  const motifs = [
    { id: "1", key: "shared" },
    { id: "2", key: "shared" },
    { id: "3", key: "other" },
  ];
  assert.deepEqual(
    findSharedMotifReferences(motifs, "1", "shared", (motif) => motif.key).map(
      (motif) => motif.id,
    ),
    ["2"],
  );
});

test("repeated completion finds the already saved upload", () => {
  const motifs = [{ id: "1", r2_key: "motifs/katze/key.png" }];
  assert.equal(findMotifByStorageKey(motifs, motifs[0].r2_key), motifs[0]);
});

test("an upload key must match the selected category and key shape", () => {
  const key = "motifs/katze/49a34a27-50a4-484a-9a17-504d57dfe11e-katze-28.png";
  assert.equal(isMotifUploadKeyForCategory(key, "katze"), true);
  assert.equal(isMotifUploadKeyForCategory(key, "hund"), false);
  assert.equal(isMotifUploadKeyForCategory("Katze/katze-28.png", "katze"), false);
});
