import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { objectKeys, parseArgs, prepareItem, selectionFingerprint,
  selectApprovedReview, validatePlan, verifyPreflightReport } from "./stage.mjs";

test("requires an explicit batch size or all", () => {
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(["--all", "--limit", "10"]));
  assert.throws(() => parseArgs(["--all", "--approved-only"]));
  assert.throws(() => parseArgs(["--approved-only"]));
  assert.deepEqual(parseArgs(["--limit", "10"]), {
    upload: false, limit: 10, all: false, approvedOnly: false, approve: null,
  });
  assert.deepEqual(parseArgs(["--approved-only", "--approve-review", "approval.json"]), {
    upload: false, limit: null, all: false, approvedOnly: true, approve: "approval.json",
  });
});

test("approved review selection preserves the seven explicit exclusions and requires a full partition", () => {
  const excluded = ["motorrad-13", "fuchs-34", "fuchs-35", "fuchs-36",
    "fuchs-10", "fuchs-12", "fussball-14"];
  const plan = { entries: [{ motif_id: "tiger-13", needs_review: true }] };
  const inventory = { schema: 1, items: ["tiger-13", "dino-41", ...excluded]
    .map((motif_id) => ({ motif_id, needs_review: true })) };
  const approval = { schema: 1, approved_motif_ids: ["tiger-13"],
    approved_without_safe_shopify_target: ["dino-41"], excluded_motif_ids: excluded };
  assert.deepEqual(selectApprovedReview(plan, inventory, approval), plan.entries);
  assert.throws(() => selectApprovedReview(plan, inventory,
    { ...approval, approved_motif_ids: ["tiger-13", "fuchs-34"],
      excluded_motif_ids: excluded.filter((id) => id !== "fuchs-34") }), /sieben/);
  assert.throws(() => selectApprovedReview(plan, inventory,
    { ...approval, approved_without_safe_shopify_target: [] }), /Qualitätsprüfliste/);
  assert.throws(() => selectApprovedReview(plan, inventory,
    { ...approval, approved_motif_ids: ["tiger-13", "tiger-13"] }), /Doppelte/);
});

test("same source produces stable versioned master and variants", () => {
  const item = { id: "gid://shopify/Metaobject/1", source_sha256: "1".repeat(64),
    category_handle: "fuchs", motif_id: "fuchs-31.1" };
  const keys = objectKeys(item);
  assert.deepEqual(keys, objectKeys(item));
  assert.match(keys.master, /^motifs-v2\/fuchs\/[a-f0-9-]{36}-fuchs-31\.1\.png$/);
  assert.equal(keys.thumbnail, keys.master.replace("motifs-v2/", "motifs-v2-thumbs/") + ".webp");
  assert.equal(keys.preview, keys.master.replace("motifs-v2/", "motifs-v2-previews/") + ".webp");
});

test("offline preparation preserves a >2000 px PNG byte-for-byte and checks its inventory", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "baurelia-stage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await sharp({ create: { width: 2101, height: 1200, channels: 4,
    background: { r: 255, g: 100, b: 20, alpha: 0.5 } } }).png().toBuffer();
  await writeFile(path.join(directory, "bild.png"), source);
  const item = {
    id: "gid://shopify/Metaobject/1", handle: "affe-1", category_handle: "affe", motif_id: "affe-1",
    source_path: "bild.png", source_sha256: createHash("sha256").update(source).digest("hex"),
    source_bytes: source.length, width: 2101, height: 1200, has_alpha: true, needs_review: false,
  };
  const prepared = await prepareItem(item, directory);
  assert.deepEqual(prepared.master, source);
  assert.equal(prepared.details.master.width, 2101);
  assert.equal(prepared.details.master.height, 1200);
  assert.equal(prepared.details.master.sha256, item.source_sha256);
  assert.equal((await sharp(prepared.variants.thumbnail).metadata()).width, 300);
  assert.equal((await sharp(prepared.variants.preview).metadata()).width, 900);

  const fingerprint = selectionFingerprint("a".repeat(64), null,
    { all: true, limit: null }, [item]);
  const report = { schema: 2, shop: "3f14b7-2.myshopify.com", status: "passed",
    selection_fingerprint: fingerprint, entries: [prepared.details], errors: [] };
  assert.doesNotThrow(() => verifyPreflightReport(report, fingerprint, [item]));
  assert.throws(() => verifyPreflightReport(report, "b".repeat(64), [item]), /Vorprüfung/);
  assert.throws(() => verifyPreflightReport({ ...report, status: "failed" }, fingerprint, [item]), /Vorprüfung/);
  assert.throws(() => verifyPreflightReport({ ...report, entries: [{ ...prepared.details,
    master: { ...prepared.details.master, bytes: 1 } }] }, fingerprint, [item]), /Vorprüfungsbericht/);

  await writeFile(path.join(directory, "bild.png"), Buffer.concat([source, Buffer.from([0])]));
  await assert.rejects(prepareItem(item, directory), /geändert/);
  await writeFile(path.join(directory, "bild.png"), source);
  await assert.rejects(prepareItem({ ...item, width: 2100 }, directory), /PNG-Metadaten/);
  assert.deepEqual(await readFile(path.join(directory, "bild.png")), source);
});

test("plan validation refuses duplicate Shopify targets before any upload", () => {
  const item = { id: "gid://shopify/Metaobject/1", handle: "affe-1", category_handle: "affe",
    motif_id: "affe-1", source_path: "bild.png", source_sha256: "1".repeat(64),
    source_bytes: 100, width: 100, height: 100, has_alpha: true, needs_review: false };
  const plan = { schema: 1, shop: "3f14b7-2.myshopify.com", base_dir: os.tmpdir(),
    entries: [item, { ...item, motif_id: "affe-2" }], unresolved: [] };
  assert.throws(() => validatePlan(plan), /Doppelte Metaobjekt-ID/);
});
