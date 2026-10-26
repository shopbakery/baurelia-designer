import test from "node:test";
import assert from "node:assert/strict";
import { inspectMotifFile } from "./motif-quality.browser.js";

test("the browser rejects an opaque image below 1400px before upload", async () => {
  const previous = globalThis.createImageBitmap;
  let closed = false;
  globalThis.createImageBitmap = async () => ({
    width: 1399,
    height: 900,
    close: () => { closed = true; },
  });
  try {
    const result = await inspectMotifFile({ type: "image/jpeg" });
    assert.match(result.error, /1399 px/);
    assert.equal(closed, true);
  } finally {
    globalThis.createImageBitmap = previous;
  }
});

test("the browser measures transparent content rather than canvas size", async () => {
  const previousBitmap = globalThis.createImageBitmap;
  const previousDocument = globalThis.document;
  const pixels = new Uint8Array(2000 * 2000 * 4);
  for (let y = 600; y < 1400; y += 1) {
    for (let x = 300; x < 1700; x += 1) {
      pixels[(y * 2000 + x) * 4 + 3] = 255;
    }
  }
  globalThis.createImageBitmap = async () => ({
    width: 2000,
    height: 2000,
    close: () => {},
  });
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: () => {},
        getImageData: () => ({ data: pixels }),
      }),
    }),
  };
  try {
    const result = await inspectMotifFile({ type: "image/png" });
    assert.deepEqual([result.visibleWidth, result.visibleHeight], [1400, 800]);
    assert.equal(result.error, "");
  } finally {
    globalThis.createImageBitmap = previousBitmap;
    globalThis.document = previousDocument;
  }
});

test("the browser reports final master dimensions after resizing", async () => {
  const previous = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => ({
    width: 3000,
    height: 1500,
    close: () => {},
  });
  try {
    const result = await inspectMotifFile({ type: "image/jpeg" });
    assert.equal(result.error, "");
    assert.deepEqual([result.masterWidth, result.masterHeight], [2000, 1000]);
  } finally {
    globalThis.createImageBitmap = previous;
  }
});
