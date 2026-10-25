import test from "node:test";
import assert from "node:assert/strict";
import { buildCleanupPlan, variantKeys } from "./cleanup-old.mjs";

const oldKey = "motifs-v2/affe/old-affe-1.png";
const newKey = "motifs-v2/affe/new-affe-1.png";
const old = variantKeys(oldKey);
const newer = variantKeys(newKey);
const entry = {
  id: "gid://shopify/Metaobject/1", handle: "affe-1", category_handle: "affe",
  motif_id: "affe-1", old_key: oldKey, new_key: newKey,
  sha256: "a".repeat(64), content_length: 100,
  variants: { thumbnail: { sha256: "b".repeat(64), content_length: 20 },
    preview: { sha256: "c".repeat(64), content_length: 40 } },
};
const catalog = {
  schema: 1, shop: "3f14b7-2.myshopify.com", source: "existing_store_app_proxy",
  scope: "active_categories_and_verified_active_motifs",
  exported_at: "2026-10-25T09:00:00.000Z",
  motifs: [{ id: entry.id, handle: entry.handle, category_handle: entry.category_handle,
    r2_key: newKey, image_url: `https://media.baurelia.ch/${newKey}`,
    thumbnail_url: `https://media.baurelia.ch/${newer.thumbnail}` }],
};
const manifests = [{ schema: 1, shop: catalog.shop, entries: [entry] }];
const objects = new Map([
  [old.master, { bytes: 80 }], [old.thumbnail, { bytes: 15 }], [old.preview, { bytes: 30 }],
  [newer.master, { bytes: 100 }], [newer.thumbnail, { bytes: 20 }],
  [newer.preview, { bytes: 40 }],
]);

test("only old exact keys are scheduled and every new file is required", () => {
  const plan = buildCleanupPlan(catalog, manifests, objects);
  assert.equal(plan.switched_motifs, 1);
  assert.deepEqual(plan.objects.map((item) => item.key), Object.values(old));
  assert.equal(plan.bytes_to_delete, 125);
  assert.equal(plan.expected_new.length, 3);
  const withoutPreview = new Map(objects);
  withoutPreview.delete(newer.preview);
  assert.throws(() => buildCleanupPlan(catalog, manifests, withoutPreview), /Neue Datei fehlt/);
});

test("still referenced old images and mismatched Shopify thumbnails block deletion", () => {
  const linked = { ...catalog, motifs: [...catalog.motifs,
    { id: "gid://shopify/Metaobject/2", r2_key: oldKey }] };
  assert.throws(() => buildCleanupPlan(linked, manifests, objects), /weiterhin/);
  const wrongThumbnail = { ...catalog, motifs: [{ ...catalog.motifs[0],
    thumbnail_url: `https://media.baurelia.ch/${old.thumbnail}` }] };
  assert.throws(() => buildCleanupPlan(wrongThumbnail, manifests, objects), /Shopify verwendet/);
});

test("unsafe object keys are rejected", () => {
  assert.throws(() => variantKeys("motifs-v2/affe/../other.png"), /Ungültiger/);
  assert.throws(() => variantKeys("motifs-v2/affe/old.webp"), /Ungültiger/);
});
