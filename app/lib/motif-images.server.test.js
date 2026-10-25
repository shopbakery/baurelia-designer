import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { buildMotifImages } from "./motif-images.server.js";

test("new transparent motifs get a 2000px master and transparent WebP variants", async () => {
  const visible = await sharp({
    create: { width: 3400, height: 1600, channels: 4, background: "#ff0000ff" },
  }).png().toBuffer();
  const source = await sharp({
    create: {
      width: 4000,
      height: 2000,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([{ input: visible, left: 300, top: 200 }]).png().toBuffer();
  const result = await buildMotifImages(source, "image/png");
  assert.equal(result.resizedMaster, true);
  assert.ok(result.visible.width >= 1700);

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

test("qualifying masters are copied byte-for-byte and variants are not enlarged", async () => {
  const source = await sharp({
    create: { width: 1600, height: 800, channels: 4, background: "#ff000080" },
  }).png().toBuffer();
  const result = await buildMotifImages(source, "image/png");
  assert.equal(result.resizedMaster, false);
  assert.deepEqual(result.master, source);
  for (const bytes of Object.values(result.variants)) {
    const metadata = await sharp(bytes).metadata();
    assert.deepEqual(
      [metadata.width, metadata.height],
      bytes === result.variants.thumbnail ? [300, 150] : [900, 450],
    );
    assert.equal(metadata.hasAlpha, true);
  }
});

test("the 1500px boundary is inclusive and a smaller visible motif is rejected", async () => {
  const accepted = await sharp({
    create: { width: 1500, height: 750, channels: 4, background: "#ff0000ff" },
  }).png().toBuffer();
  assert.equal((await buildMotifImages(accepted, "image/png")).visible.width, 1500);

  const tooSmall = await sharp({
    create: { width: 1499, height: 750, channels: 4, background: "#ff0000ff" },
  }).png().toBuffer();
  await assert.rejects(buildMotifImages(tooSmall, "image/png"), (error) =>
    error.code === "MOTIF_RESOLUTION" && /1499 px/.test(error.message));
});

test("transparent canvas padding cannot disguise an undersized motif", async () => {
  const visible = await sharp({
    create: { width: 1400, height: 800, channels: 4, background: "#ff0000ff" },
  }).png().toBuffer();
  const padded = await sharp({
    create: { width: 2000, height: 2000, channels: 4, background: "#00000000" },
  }).composite([{ input: visible, left: 300, top: 600 }]).png().toBuffer();
  await assert.rejects(buildMotifImages(padded, "image/png"), (error) =>
    error.code === "MOTIF_RESOLUTION" && /1400 px/.test(error.message));
});

test("quality is checked after shrinking the print master to 2000px", async () => {
  const visible = await sharp({
    create: { width: 2500, height: 2500, channels: 4, background: "#ff0000ff" },
  }).png().toBuffer();
  const source = await sharp({
    create: { width: 4000, height: 4000, channels: 4, background: "#00000000" },
  }).composite([{ input: visible, left: 750, top: 750 }]).png().toBuffer();
  await assert.rejects(buildMotifImages(source, "image/png"), (error) =>
    error.code === "MOTIF_RESOLUTION" && /1250 px/.test(error.message));
});

test("fully transparent images are rejected", async () => {
  const source = await sharp({
    create: { width: 2000, height: 2000, channels: 4, background: "#00000000" },
  }).png().toBuffer();
  await assert.rejects(buildMotifImages(source, "image/png"), (error) =>
    error.code === "MOTIF_RESOLUTION" && /vollständig transparent/.test(error.message));
});

test("mismatched MIME types and non-images are rejected", async () => {
  const png = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "red" },
  }).png().toBuffer();
  await assert.rejects(buildMotifImages(png, "image/jpeg"), /kein gültiges/);
  await assert.rejects(buildMotifImages(Buffer.from("not an image"), "image/png"));
});
