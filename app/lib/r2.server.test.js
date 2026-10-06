import test from "node:test";
import assert from "node:assert/strict";
import {
  motifKeyFromPublicUrl,
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

test("legacy image and thumbnail URLs follow the current R2 domain", () => {
  process.env.R2_PUBLIC_URL = newPublicUrl;
  const oldThumbnail =
    `https://images.weserv.nl/?url=${oldPublicUrl.slice(8)}/Affe/affe-1%404x.png` +
    "&w=100&h=100&fit=inside&q=80&bg=ffffff";
  const motif = motifWithCurrentPublicUrls({
    image_url: `${oldPublicUrl}/Affe/affe-1%404x.png`,
    thumbnail_url: oldThumbnail,
  });

  assert.equal(motif.image_url, `${newPublicUrl}/Affe/affe-1%404x.png`);
  const thumbnail = new URL(motif.thumbnail_url);
  assert.equal(
    thumbnail.searchParams.get("url"),
    "media.baurelia.ch/Affe/affe-1%404x.png",
  );
  assert.equal(thumbnail.searchParams.get("w"), "100");
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
    `${newPublicUrl}/Ballerina/Ballerina%2012.png`,
  );
  assert.equal(current.thumbnailUrl, current.imageUrl);
  assert.equal(source.imageUrl.startsWith(oldPublicUrl), true);
});

test("an already updated image also updates a stale thumbnail proxy", () => {
  process.env.R2_PUBLIC_URL = newPublicUrl;
  const motif = motifWithCurrentPublicUrls({
    image_url: `${newPublicUrl}/Affe/affe-1%404x.png`,
    thumbnail_url:
      `https://images.weserv.nl/?url=${oldPublicUrl.slice(8)}/Affe/affe-1%404x.png&w=100`,
  });
  assert.equal(
    new URL(motif.thumbnail_url).searchParams.get("url"),
    "media.baurelia.ch/Affe/affe-1%404x.png",
  );
});
