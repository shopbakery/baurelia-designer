import test from "node:test";
import assert from "node:assert/strict";
import { buildPlan, identity } from "./plan.mjs";

test("file identity preserves numbered suffixes", () => {
  assert.equal(identity("Fuchs 31.1.png"), "fuchs-31.1");
  assert.equal(identity("fuchs-31.1"), "fuchs-31.1");
  assert.equal(identity("motifs-v2/fuchs/12345678-1234-1234-1234-123456789abc-fuchs-31.1.png"), "fuchs-31.1");
});

test("exact storage key wins; ambiguous customer-only source is blocked", () => {
  const sources = { schema: 1, base_dir: "C:/sources", items: [
    { motif_id: "fuchs-3", old_r2_key: "motifs-v2/fuchs/old-fuchs-3.png" },
    { motif_id: "fuchs-31.1", old_r2_key: null },
  ] };
  const catalog = { shop: "3f14b7-2.myshopify.com", motifs: [
    { id: "1", handle: "fuchs-3", category_handle: "fuchs", r2_key: "motifs-v2/fuchs/old-fuchs-3.png" },
    { id: "2", handle: "first", category_handle: "fuchs", slug: "fuchs-31.1", r2_key: "one.png" },
    { id: "3", handle: "second", category_handle: "fuchs", original_filename: "Fuchs 31.1.png", r2_key: "two.png" },
  ] };
  const plan = buildPlan(sources, catalog);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].id, "1");
  assert.equal(plan.unresolved.length, 1);
  assert.equal(plan.unresolved[0].reason, "mehrdeutig");
  const resolved = buildPlan(sources, catalog, { "fuchs-31.1": "first" });
  assert.equal(resolved.entries.length, 2);
  assert.equal(resolved.unresolved.length, 0);
  assert.equal(resolved.entries[1].match_method, "manual_override");
});
