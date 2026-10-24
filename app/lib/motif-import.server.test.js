import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMotifImportBatch,
  inspectMotifImportBatch,
  motifImportKeys,
  targetMotifFields,
  validateMotifImportBatch,
} from "./motif-import.server.js";

const source = {
  id: "gid://shopify/Metaobject/123",
  handle: "affe-1",
  category_handle: "affe",
  motif_id: "affe-1",
  old_key: "motifs-v2/affe/old.png",
  old_updated_at: "2026-10-10T06:43:22Z",
  sha256: "a".repeat(64),
  content_length: 7_000_000,
  variants: {
    thumbnail: { sha256: "b".repeat(64), content_length: 24_000 },
    preview: { sha256: "c".repeat(64), content_length: 135_000 },
  },
};
const entry = { ...source, new_key: motifImportKeys(source).master };
const publicUrlForKey = (key) => `https://media.baurelia.ch/${key.split("/").map(encodeURIComponent).join("/")}`;
const keyFromPublicUrl = (url) => url?.startsWith("https://media.baurelia.ch/")
  ? decodeURIComponent(url.slice("https://media.baurelia.ch/".length)) : "";
const oldMotif = {
  id: source.id,
  handle: source.handle,
  type: "$app:motif",
  category_handle: source.category_handle,
  updatedAt: source.old_updated_at,
  r2_key: source.old_key,
  image_url: "https://media.baurelia.ch/old.png",
  thumbnail_url: "https://media.baurelia.ch/old.webp",
};

function heads(item = entry) {
  const keys = motifImportKeys(item);
  return new Map([
    [keys.master, {
      ContentLength: item.content_length,
      ContentType: "image/png",
      Metadata: { sha256: item.sha256 },
    }],
    [keys.thumbnail, {
      ContentLength: item.variants.thumbnail.content_length,
      ContentType: "image/webp",
      Metadata: { sha256: item.variants.thumbnail.sha256 },
    }],
    [keys.preview, {
      ContentLength: item.variants.preview.content_length,
      ContentType: "image/webp",
      Metadata: { sha256: item.variants.preview.sha256 },
    }],
  ]);
}

test("batch requires unambiguous IDs, deterministic key and variant checksums", () => {
  assert.deepEqual(validateMotifImportBatch([entry]), [entry]);
  assert.throws(() => validateMotifImportBatch([]), /1 bis 10/);
  assert.throws(() => validateMotifImportBatch(Array(11).fill(entry)), /1 bis 10/);
  assert.throws(() => validateMotifImportBatch([entry, entry]), /doppelte/);
  assert.throws(() => validateMotifImportBatch([{ ...entry, new_key: "motifs-v2/affe/other.png" }]), /Zuordnung/);
  assert.throws(() => validateMotifImportBatch([{ ...entry, variants: undefined }]), /Prüfdaten/);
  assert.throws(() => validateMotifImportBatch([{ ...entry,
    variants: { ...entry.variants, preview: { sha256: "x", content_length: 10 } },
  }]), /Prüfdaten/);
  assert.throws(() => validateMotifImportBatch([{ ...entry,
    content_length: 10 * 1024 * 1024 + 1,
  }]), /Prüfdaten/);
});

test("inspection reads Shopify and all three R2 objects without changing anything", async () => {
  const store = heads();
  const readKeys = [];
  const inspection = await inspectMotifImportBatch([entry], {
    publicUrlForKey,
    loadMotif: async (id) => {
      assert.equal(id, entry.id);
      return oldMotif;
    },
    headObject: async (key) => {
      readKeys.push(key);
      return store.get(key);
    },
  });
  assert.deepEqual(readKeys, Object.values(motifImportKeys(entry)));
  assert.deepEqual(inspection.results, [{ id: entry.id, handle: entry.handle, status: "ready" }]);
  assert.equal(inspection.checked[0].alreadyDone, false);
  assert.deepEqual(inspection.checked[0].target, targetMotifFields(entry, publicUrlForKey));
});

test("a missing or wrong variant blocks the entire batch before mutation", async () => {
  const store = heads();
  store.get(motifImportKeys(entry).preview).Metadata.sha256 = "d".repeat(64);
  await assert.rejects(inspectMotifImportBatch([entry], {
    publicUrlForKey,
    loadMotif: async () => oldMotif,
    headObject: async (key) => store.get(key),
  }), /R2-Datei entspricht nicht dem Manifest/);
  store.delete(motifImportKeys(entry).thumbnail);
  await assert.rejects(inspectMotifImportBatch([entry], {
    publicUrlForKey,
    loadMotif: async () => oldMotif,
    headObject: async (key) => store.get(key),
  }), /R2-Datei entspricht nicht dem Manifest/);
});

test("changed Shopify identity or version stops before any update", async () => {
  const store = heads();
  for (const changed of [
    { handle: "other" }, { category_handle: "kuh" },
    { r2_key: "motifs-v2/affe/other.png" },
    { updatedAt: "2026-10-20T00:00:00Z" },
    { type: "$app:other" }, { type: undefined },
  ]) {
    await assert.rejects(inspectMotifImportBatch([entry], {
      publicUrlForKey,
      loadMotif: async () => ({ ...oldMotif, ...changed }),
      headObject: async (key) => store.get(key),
    }), /stimmt nicht|geändert/);
  }
});

test("old storage key can be recovered from its existing public URL", async () => {
  const store = heads();
  const inspection = await inspectMotifImportBatch([entry], {
    publicUrlForKey,
    keyFromPublicUrl,
    loadMotif: async () => ({ ...oldMotif, r2_key: "",
      image_url: publicUrlForKey(entry.old_key) }),
    headObject: async (key) => store.get(key),
  });
  assert.equal(inspection.results[0].status, "ready");
});

test("legacy Shopify key is matched through the verified public migration map", async () => {
  const legacySource = { ...source, handle: "affe-17", motif_id: "affe-17",
    old_key: "motifs-v2/affe/Affe 17.png" };
  const legacyEntry = { ...legacySource, new_key: motifImportKeys(legacySource).master };
  const store = heads(legacyEntry);
  const legacyMotif = { ...oldMotif, handle: legacyEntry.handle, r2_key: "",
    image_url: "https://pub-049e86916f8f447aab9e07fd4144ab91.r2.dev/Affe/Affe%2017.png" };
  const dependencies = {
    publicUrlForKey,
    keyFromPublicUrl: () => "Affe/Affe 17.png",
    loadMotif: async () => legacyMotif,
    headObject: async (key) => store.get(key),
  };
  const inspection = await inspectMotifImportBatch([legacyEntry], dependencies);
  assert.equal(inspection.results[0].status, "ready");
  await assert.rejects(inspectMotifImportBatch([legacyEntry], {
    ...dependencies,
    loadMotif: async () => ({ ...legacyMotif, updatedAt: "2026-10-24T18:00:00Z" }),
  }), /seit dem Katalogexport geändert/);
  await assert.rejects(inspectMotifImportBatch([legacyEntry], {
    ...dependencies,
    keyFromPublicUrl: () => "Affe/another.png",
  }), /Bildschlüssel stimmt nicht/);
  let live = legacyMotif;
  const applied = await applyMotifImportBatch(inspection.checked, {
    ...dependencies,
    loadMotif: async () => live,
    updateMotif: async (id, values) => {
      assert.equal(id, legacyEntry.id);
      live = { ...live, ...values, updatedAt: "2026-10-24T18:00:00Z" };
    },
  });
  assert.equal(applied[0].status, "updated");
  const repeated = await inspectMotifImportBatch([legacyEntry], {
    ...dependencies, loadMotif: async () => live,
  });
  assert.equal(repeated.results[0].status, "already_done");
});

test("apply updates only three image fields by ID, checks read-back and is idempotent", async () => {
  const store = heads();
  let current = { ...oldMotif };
  const updates = [];
  const deps = {
    publicUrlForKey,
    loadMotif: async () => current,
    headObject: async (key) => store.get(key),
    updateMotif: async (id, fields) => {
      updates.push({ id, fields });
      current = { ...current, ...fields, updatedAt: "2026-10-24T18:00:00Z" };
    },
  };
  const inspected = await inspectMotifImportBatch([entry], deps);
  assert.deepEqual(await applyMotifImportBatch(inspected.checked, deps), [
    { id: entry.id, handle: entry.handle, status: "updated" },
  ]);
  assert.deepEqual(updates, [{ id: entry.id, fields: targetMotifFields(entry, publicUrlForKey) }]);
  assert.deepEqual(Object.keys(updates[0].fields), ["r2_key", "image_url", "thumbnail_url"]);
  const repeat = await inspectMotifImportBatch([entry], deps);
  assert.equal(repeat.checked[0].alreadyDone, true);
  assert.deepEqual(await applyMotifImportBatch(repeat.checked, deps), [
    { id: entry.id, handle: entry.handle, status: "already_done" },
  ]);
  assert.equal(updates.length, 1);
});

test("apply rechecks Shopify version before writing and stops on failed read-back", async () => {
  const store = heads();
  const inspected = await inspectMotifImportBatch([entry], {
    publicUrlForKey,
    loadMotif: async () => oldMotif,
    headObject: async (key) => store.get(key),
  });
  let mutations = 0;
  await assert.rejects(applyMotifImportBatch(inspected.checked, {
    publicUrlForKey,
    loadMotif: async () => ({ ...oldMotif, updatedAt: "2026-10-24T18:00:00Z" }),
    updateMotif: async () => { mutations += 1; },
  }), /geändert/);
  assert.equal(mutations, 0);
  await assert.rejects(applyMotifImportBatch(inspected.checked, {
    publicUrlForKey,
    loadMotif: async () => oldMotif,
    updateMotif: async () => { mutations += 1; },
  }), /Rückleseprüfung/);
  assert.equal(mutations, 1);
});
