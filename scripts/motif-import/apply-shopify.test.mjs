import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  applyEntries,
  classifyCurrent,
  createAdminClient,
  normalizeMetaobject,
  parseArgs,
  targetFields,
  validateManifest,
  versionedKey,
} from "./apply-shopify.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const source = {
  id: "gid://shopify/Metaobject/123", handle: "affe-1", category_handle: "affe",
  motif_id: "affe-1", source_sha256: "a".repeat(64), source_bytes: 1234,
  old_key: "motifs-v2/affe/old.png", old_updated_at: "2026-10-10T06:43:22Z",
  needs_review: false,
};
const plan = { schema: 1, shop: "3f14b7-2.myshopify.com", catalog_exported_at: "2026-10-24T16:15:45Z", entries: [source] };
const planBytes = Buffer.from(JSON.stringify(plan));
const entry = {
  id: source.id, handle: source.handle, category_handle: source.category_handle,
  motif_id: source.motif_id, old_key: source.old_key, old_updated_at: source.old_updated_at,
  new_key: versionedKey(source), sha256: source.source_sha256,
  content_length: source.source_bytes,
};
const manifest = {
  schema: 1, shop: plan.shop, catalog_exported_at: plan.catalog_exported_at,
  plan_sha256: hash(planBytes), entries: [entry],
};
const current = {
  id: source.id, handle: source.handle, type: "$app:motif",
  category_handle: source.category_handle, r2_key: source.old_key,
  updated_at: source.old_updated_at,
};

function node(fields, updatedAt = source.old_updated_at) {
  return { id: source.id, handle: source.handle, type: "$app:motif", updatedAt,
    fields: Object.entries(fields).map(([key, jsonValue]) => ({ key, jsonValue })) };
}

test("default is token-free dry-run; explicit manifest required", () => {
  assert.deepEqual(parseArgs(["--manifest", "sample.json"]).apply, false);
  assert.equal(parseArgs(["--manifest", "sample.json", "--apply"]).apply, true);
  assert.throws(() => parseArgs([]), /--manifest/);
  assert.throws(() => createAdminClient(""), /SHOPIFY_ADMIN_ACCESS_TOKEN/);
});

test("manifest must match original plan and exclude review items", () => {
  assert.deepEqual(validateManifest(manifest, plan, planBytes), [entry]);
  assert.throws(() => validateManifest({ ...manifest, plan_sha256: "b".repeat(64) }, plan, planBytes), /Plan/);
  assert.throws(() => validateManifest({ ...manifest, entries: [{ ...entry, new_key: "other.png" }] }, plan, planBytes), /Zuordnung/);
  assert.throws(() => validateManifest(manifest, { ...plan, entries: [{ ...source, needs_review: true }] }, planBytes), /Zuordnung/);
});

test("live record mismatch or updatedAt conflict stops before mutation", async () => {
  assert.equal(classifyCurrent(entry, current), "update");
  assert.throws(() => classifyCurrent(entry, { ...current, updated_at: "2026-10-20T00:00:00Z" }), /geändert/);
  assert.throws(() => classifyCurrent(entry, { ...current, category_handle: "kuh" }), /Kategorie/);
  let calls = 0;
  await assert.rejects(applyEntries([entry], async () => {
    calls += 1;
    return { metaobject: node({ category_handle: "kuh", r2_key: source.old_key }) };
  }, () => {}), /Kategorie/);
  assert.equal(calls, 1);
});

test("apply writes only three image fields and verifies a fresh read-back", async () => {
  const target = targetFields(entry);
  let changed = false;
  let mutations = 0;
  const graphql = async (query, variables) => {
    if (query.includes("metaobjectUpdate")) {
      mutations += 1;
      assert.equal(variables.id, source.id);
      assert.deepEqual(Object.fromEntries(variables.metaobject.fields.map(({ key, value }) => [key, value])), target);
      assert.equal(variables.metaobject.fields.length, 3);
      changed = true;
      return { metaobjectUpdate: { metaobject: { id: source.id, handle: source.handle }, userErrors: [] } };
    }
    return { metaobject: node({ category_handle: source.category_handle,
      ...(changed ? target : { r2_key: source.old_key }) }) };
  };
  const first = await applyEntries([entry], graphql, () => {});
  const second = await applyEntries([entry], graphql, () => {});
  assert.deepEqual(first, [{ motif_id: "affe-1", status: "updated" }]);
  assert.deepEqual(second, [{ motif_id: "affe-1", status: "already_done" }]);
  assert.equal(mutations, 1);
  assert.equal(normalizeMetaobject(node({ category_handle: "affe" })).category_handle, "affe");
});

test("read-back URL mismatch stops the import", async () => {
  let changed = false;
  await assert.rejects(applyEntries([entry], async (query) => {
    if (query.includes("metaobjectUpdate")) {
      changed = true;
      return { metaobjectUpdate: { metaobject: { id: source.id, handle: source.handle }, userErrors: [] } };
    }
    return { metaobject: node({ category_handle: source.category_handle,
      ...(changed ? { r2_key: entry.new_key, image_url: "https://wrong.test/image.png" } :
        { r2_key: source.old_key }) }) };
  }, () => {}), /abweichenden URLs/);
});

test("Admin API endpoint is pinned to the intended shop and 2026-07", async () => {
  const observed = [];
  const graphql = createAdminClient("test-token", async (url, init) => {
    observed.push({ url, init });
    return { ok: true, json: async () => ({ data: { metaobject: null } }) };
  });
  await graphql("query { shop { id } }", {});
  assert.equal(observed[0].url, "https://3f14b7-2.myshopify.com/admin/api/2026-07/graphql.json");
  assert.equal(observed[0].init.headers["X-Shopify-Access-Token"], "test-token");
});
