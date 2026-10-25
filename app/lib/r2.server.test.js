import test from "node:test";
import assert from "node:assert/strict";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";
import {
  completeMotifImages,
  completeNewMotifImages,
  createMotifUpload,
  currentMotifKey,
  hasVerifiedMotifObject,
  headMotifImportObject,
  motifKeyFromPublicUrl,
  motifVariantKeys,
  motifWithCurrentPublicUrls,
} from "./r2.server.js";

const oldPublicUrl =
  "https://pub-049e86916f8f447aab9e07fd4144ab91.r2.dev";
const newPublicUrl = "https://media.baurelia.ch";

test("legacy motif links resolve to the migrated object key", () => {
  process.env.R2_PUBLIC_URL = newPublicUrl;
  assert.equal(
    motifKeyFromPublicUrl(`${oldPublicUrl}/Affe/affe-1%404x.png`),
    "Affe/affe-1@4x.png",
  );
  assert.equal(
    motifKeyFromPublicUrl(`${newPublicUrl}/Affe/affe-1%404x.png`),
    "Affe/affe-1@4x.png",
  );
  assert.equal(motifKeyFromPublicUrl("https://example.com/other.png"), "");
});

test("migrated motifs use local R2 WebP variants instead of the old image proxy", () => {
  process.env.R2_PUBLIC_URL = newPublicUrl;
  const oldThumbnail =
    `https://images.weserv.nl/?url=${oldPublicUrl.slice(8)}/Affe/affe-1%404x.png` +
    "&w=100&h=100&fit=inside&q=80&bg=ffffff";
  const motif = motifWithCurrentPublicUrls({
    image_url: `${oldPublicUrl}/Affe/affe-1%404x.png`,
    thumbnail_url: oldThumbnail,
  });

  assert.equal(motif.image_url, `${newPublicUrl}/motifs-v2/affe/affe-1%404x.png`);
  assert.equal(motif.r2_key, "motifs-v2/affe/affe-1@4x.png");
  assert.equal(motif.thumbnail_url, `${newPublicUrl}/motifs-v2-thumbs/affe/affe-1%404x.png.webp`);
  assert.equal(motif.previewUrl, `${newPublicUrl}/motifs-v2-previews/affe/affe-1%404x.png.webp`);
});

test("legacy catalog fields are updated without mutating the source", () => {
  process.env.R2_PUBLIC_URL = newPublicUrl;
  const source = {
    imageUrl: `${oldPublicUrl}/Ballerina/Ballerina%2012.png`,
    thumbnailUrl: "",
  };
  const current = motifWithCurrentPublicUrls(source);
  assert.equal(
    current.imageUrl,
    `${newPublicUrl}/motifs-v2/ballerina/Ballerina%2012.png`,
  );
  assert.equal(current.thumbnailUrl, `${newPublicUrl}/motifs-v2-thumbs/ballerina/Ballerina%2012.png.webp`);
  assert.equal(current.previewUrl, `${newPublicUrl}/motifs-v2-previews/ballerina/Ballerina%2012.png.webp`);
  assert.equal(source.imageUrl.startsWith(oldPublicUrl), true);
});

test("an already updated image also updates a stale thumbnail proxy", () => {
  process.env.R2_PUBLIC_URL = newPublicUrl;
  const motif = motifWithCurrentPublicUrls({
    image_url: `${newPublicUrl}/Affe/affe-1%404x.png`,
    thumbnail_url:
      `https://images.weserv.nl/?url=${oldPublicUrl.slice(8)}/Affe/affe-1%404x.png&w=100`,
  });
  assert.equal(motif.thumbnail_url, `${newPublicUrl}/motifs-v2-thumbs/affe/affe-1%404x.png.webp`);
  assert.equal(motif.previewUrl, `${newPublicUrl}/motifs-v2-previews/affe/affe-1%404x.png.webp`);
});

test("old stored R2 keys resolve to new keys without changing source records", () => {
  process.env.R2_PUBLIC_URL = newPublicUrl;
  const source = {
    r2_key: "Zahnfee/Zahnfee 9.png",
    image_url: `${newPublicUrl}/Zahnfee/Zahnfee%209.png`,
    thumbnail_url: `${newPublicUrl}/Zahnfee/Zahnfee%209.png`,
  };
  assert.equal(currentMotifKey(source), "motifs-v2/zahnfee/Zahnfee 9.png");
  const current = motifWithCurrentPublicUrls(source);
  assert.equal(current.image_url, `${newPublicUrl}/motifs-v2/zahnfee/Zahnfee%209.png`);
  assert.equal(current.thumbnail_url, `${newPublicUrl}/motifs-v2-thumbs/zahnfee/Zahnfee%209.png.webp`);
  assert.equal(current.previewUrl, `${newPublicUrl}/motifs-v2-previews/zahnfee/Zahnfee%209.png.webp`);
  assert.equal(source.r2_key, "Zahnfee/Zahnfee 9.png");
});

test("unmigrated keys keep their existing URLs", () => {
  process.env.R2_PUBLIC_URL = newPublicUrl;
  const motif = motifWithCurrentPublicUrls({
    image_url: `${newPublicUrl}/missing/not-in-report.png`,
    thumbnail_url: "",
  });
  assert.equal(motif.image_url, `${newPublicUrl}/missing/not-in-report.png`);
  assert.equal(motif.previewUrl, motif.image_url);
});

test("variant keys preserve the full master filename and only derive from v2 masters", () => {
  assert.deepEqual(motifVariantKeys("motifs-v2/zahnfee/Zahnfee 9.png"), {
    thumbnail: "motifs-v2-thumbs/zahnfee/Zahnfee 9.png.webp",
    preview: "motifs-v2-previews/zahnfee/Zahnfee 9.png.webp",
  });
  assert.equal(motifVariantKeys("Zahnfee/Zahnfee 9.png"), null);
});

test("unmigrated legacy uploads are withheld from the storefront", () => {
  process.env.R2_PUBLIC_URL = newPublicUrl;
  assert.equal(hasVerifiedMotifObject({
    r2_key: "motifs/auto/48499cee-2297-4f2b-ad5e-c2482a6d585b-white-noise-modell-bg.webp",
  }), false);
  assert.equal(hasVerifiedMotifObject({
    r2_key: "motifs/affe/203d4a70-2668-4fbe-9ef3-5a5af64cb108-affe_affe-2-4x.png",
  }), true);
  assert.equal(hasVerifiedMotifObject({ r2_key: "Affe/affe-1@4x.png" }), true);
  assert.equal(hasVerifiedMotifObject({ r2_key: "motifs-v2/auto/new.png" }), true);
});

test("new presigned uploads use motifs-v2 and remain category-specific", async () => {
  process.env.R2_PUBLIC_URL = newPublicUrl;
  process.env.R2_ACCOUNT_ID = "00000000000000000000000000000000";
  process.env.R2_ACCESS_KEY_ID = "test-access";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.R2_BUCKET_NAME = "test-bucket";
  const upload = await createMotifUpload({
    fileName: "Neues Motiv.png",
    contentType: "image/png",
    fileSize: 1024,
    categoryHandle: "zahnfee",
  });
  assert.match(upload.key, /^motifs-v2\/zahnfee\/[a-f0-9-]+-neues-motiv\.png$/);
  assert.equal(upload.publicUrl, `${newPublicUrl}/${upload.key}`);
  assert.match(upload.uploadUrl, /X-Amz-Signature=/);
});

test("import verification only HEADs scoped master and variants", async () => {
  const requested = [];
  const storage = {
    async send(command) {
      assert.ok(command instanceof HeadObjectCommand);
      requested.push(command.input.Key);
      return { ContentType: "image/webp", ContentLength: 42 };
    },
  };
  const key = "motifs-v2/affe/abc123-affe-1.png";
  const variant = motifVariantKeys(key).thumbnail;
  await headMotifImportObject(key, { storage, bucket: "test-bucket" });
  await headMotifImportObject(variant, { storage, bucket: "test-bucket" });
  assert.deepEqual(requested, [key, variant]);
  await assert.rejects(
    headMotifImportObject("other/secret.png", { storage, bucket: "test-bucket" }),
    /Ungültiger Motivimport-Schlüssel/,
  );
  assert.deepEqual(requested, [key, variant]);
});

test("completion resizes the master, creates both variants, and can be retried", async () => {
  process.env.R2_PUBLIC_URL = newPublicUrl;
  const key = "motifs-v2/zahnfee/49a34a27-50a4-484a-9a17-504d57dfe11e-test.png";
  const source = await sharp({
    create: {
      width: 4000,
      height: 2000,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  }).png().toBuffer();
  const objects = new Map([[key, { body: source, type: "image/png", etag: '"1"' }]]);
  const written = [];
  const storage = {
    async send(command) {
      const { Key, IfMatch, IfNoneMatch } = command.input;
      const existing = objects.get(Key);
      if (command instanceof HeadObjectCommand) {
        if (!existing) throw new Error("NotFound");
        return {
          ContentType: existing.type,
          ContentLength: existing.body.length,
          ETag: existing.etag,
        };
      }
      if (command instanceof GetObjectCommand) {
        if (!existing || existing.etag !== IfMatch) throw new Error("PreconditionFailed");
        return { Body: { transformToByteArray: async () => existing.body } };
      }
      if (command instanceof PutObjectCommand) {
        if (IfNoneMatch === "*" && existing) {
          throw Object.assign(new Error("PreconditionFailed"), {
            $metadata: { httpStatusCode: 412 },
          });
        }
        if (IfMatch && existing?.etag !== IfMatch) throw new Error("PreconditionFailed");
        objects.set(Key, {
          body: Buffer.from(command.input.Body),
          type: command.input.ContentType,
          etag: `"${objects.size + written.length + 1}"`,
        });
        written.push(Key);
        return {};
      }
      throw new Error("Unexpected R2 command");
    },
  };

  const first = await completeMotifImages(key, { storage, bucket: "test-bucket" });
  const variantKeys = motifVariantKeys(key);
  assert.deepEqual(written, [key, variantKeys.thumbnail, variantKeys.preview]);
  assert.equal(first.thumbnailUrl, `${newPublicUrl}/${variantKeys.thumbnail}`);
  assert.deepEqual(
    [
      (await sharp(objects.get(key).body).metadata()).width,
      (await sharp(objects.get(key).body).metadata()).height,
    ],
    [2000, 1000],
  );
  assert.equal((await sharp(objects.get(variantKeys.thumbnail).body).metadata()).width, 300);
  assert.equal((await sharp(objects.get(variantKeys.preview).body).metadata()).width, 900);

  const second = await completeMotifImages(key, { storage, bucket: "test-bucket" });
  assert.deepEqual(second, first);
  assert.equal(written.length, 3);
});

test("a newly uploaded low-resolution master is removed before variants or a Shopify record", async () => {
  const key = "motifs-v2/zahnfee/49a34a27-50a4-484a-9a17-504d57dfe11e-small.png";
  const source = await sharp({
    create: { width: 1499, height: 900, channels: 4, background: "#ff0000ff" },
  }).png().toBuffer();
  const objects = new Map([[key, source]]);
  const commands = [];
  const storage = {
    async send(command) {
      commands.push(command.constructor.name);
      if (command instanceof HeadObjectCommand) {
        return { ContentType: "image/png", ContentLength: source.length, ETag: '"1"' };
      }
      if (command instanceof GetObjectCommand) {
        return { Body: { transformToByteArray: async () => source } };
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(command.input.Key);
        return {};
      }
      if (command instanceof PutObjectCommand) {
        throw new Error("A rejected motif must not create variants");
      }
      throw new Error("Unexpected R2 command");
    },
  };
  await assert.rejects(
    completeNewMotifImages(key, { storage, bucket: "test-bucket" }),
    (error) => error.code === "MOTIF_RESOLUTION",
  );
  assert.equal(objects.has(key), false);
  assert.deepEqual(commands, [
    "HeadObjectCommand", "GetObjectCommand", "DeleteObjectCommand",
  ]);
});
