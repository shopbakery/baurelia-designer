import test from "node:test";
import assert from "node:assert/strict";
import { motifDisplayLabel, motifOriginalFilename } from "./motif-labels.js";

test("filename is restored from migrated R2 object keys", () => {
  assert.equal(
    motifOriginalFilename({
      r2_key: "motifs/katze/49a34a27-50a4-484a-9a17-504d57dfe11e-katze-28.png",
    }),
    "katze-28.png",
  );
});

test("storefront position overrides an old sort order after deletion", () => {
  const motif = { sort_order: 28 };
  assert.equal(motifDisplayLabel(motif, "Katze", 27), "Katze 27");
  assert.equal(motifDisplayLabel(motif, "Katze"), "Katze 28");
});
