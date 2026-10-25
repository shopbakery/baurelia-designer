import test from "node:test";
import assert from "node:assert/strict";
import {
  motifResolutionMessage,
  resizedMotifDimensions,
  visibleMotifBounds,
} from "./motif-quality.js";

test("visible bounds ignore effectively transparent pixels", () => {
  const pixels = new Uint8Array(4 * 3 * 4);
  pixels[3] = 15;
  pixels[(1 * 4 + 1) * 4 + 3] = 16;
  pixels[(2 * 4 + 2) * 4 + 3] = 255;
  assert.deepEqual(visibleMotifBounds(pixels, 4, 3), { width: 2, height: 2 });
});

test("a fully transparent image has no printable area", () => {
  assert.deepEqual(visibleMotifBounds(new Uint8Array(8 * 8 * 4), 8, 8), {
    width: 0, height: 0,
  });
  assert.match(motifResolutionMessage(0, 0), /vollständig transparent/);
});

test("the minimum visible long edge is exactly 1500px", () => {
  assert.match(motifResolutionMessage(1499, 900), /1499 px/);
  assert.equal(motifResolutionMessage(1500, 900), "");
  assert.deepEqual(resizedMotifDimensions(4000, 2000), {
    width: 2000, height: 1000,
  });
});
