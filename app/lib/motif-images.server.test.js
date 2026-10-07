import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { buildMotifImages } from "./motif-images.server.js";

test("new transparent motifs get a 2000px master and transparent WebP variants", async () => {
  const source = await sharp({
    create: {
      width: 4000,
      height: 2000,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).png().toBuffer();
  const result = await buildMotifImages(source, "image/png");
  assert.equal(result.resizedMaster, true);

  for (const [bytes, expected] of [
    [result.master, [2000, 1000, "png"]],
    [result.variants.thumbnail, [300, 150, "webp"]],
    [result.variants.preview, [900, 450, "webp"]],
  ]) {
    const metadata = await sharp(bytes).metadata();
    assert.deepEqual([metadata.width, metadata.height, metadata.format], expected);
    assert.equal(metadata.hasAlpha, true);
  }
});

test("small masters are copied byte-for-byte and variants are not enlarged", async () => {
  const source = await sharp({
    create: { width: 80, height: 40, channels: 4, background: "#ff000080" },
  }).png().toBuffer();
  const result = await buildMotifImages(source, "image/png");
  assert.equal(result.resizedMaster, false);
  assert.deepEqual(result.master, source);
  for (const bytes of Object.values(result.variants)) {
    const metadata = await sharp(bytes).metadata();
    assert.deepEqual([metadata.width, metadata.height], [80, 40]);
    assert.equal(metadata.hasAlpha, true);
  }
});

test("mismatched MIME types and non-images are rejected", async () => {
  const png = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "red" },
  }).png().toBuffer();
  await assert.rejects(buildMotifImages(png, "image/jpeg"), /kein gültiges/);
  await assert.rejects(buildMotifImages(Buffer.from("not an image"), "image/png"));
});
