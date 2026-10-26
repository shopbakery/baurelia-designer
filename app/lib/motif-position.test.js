import test from "node:test";
import assert from "node:assert/strict";
import { planActiveMotifMove } from "./motif-position.js";

const motif = (handle, sortOrder, active = true) => ({
  handle,
  name: handle,
  sort_order: sortOrder,
  active,
});

test("moves a motif from a later page to an earlier category position", () => {
  const motifs = Array.from({ length: 60 }, (_, index) =>
    motif(`auto-${index + 1}`, index + 1),
  );
  const plan = planActiveMotifMove(motifs, "auto-55", 3);

  assert.equal(plan.currentPosition, 55);
  assert.equal(plan.ordered[2].handle, "auto-55");
  assert.equal(plan.ordered[3].handle, "auto-3");
  assert.equal(plan.ordered[54].handle, "auto-54");
  assert.deepEqual(
    plan.updates.map(({ motif: item }) => item.handle),
    plan.ordered.slice(2, 55).map((item) => item.handle),
  );
  assert.equal(motifs[54].handle, "auto-55");
});

test("counts active positions while leaving inactive motifs in place", () => {
  const motifs = [
    motif("one", 1),
    motif("inactive", 2, false),
    motif("two", 3),
    motif("three", 4),
  ];
  const plan = planActiveMotifMove(motifs, "three", 1);

  assert.deepEqual(plan.ordered.map((item) => item.handle), [
    "three", "inactive", "one", "two",
  ]);
  assert.equal(plan.updates.some(({ motif: item }) => item.handle === "inactive"), false);
});

test("rejects missing, inactive and out-of-range positions", () => {
  const motifs = [motif("one", 1), motif("inactive", 2, false)];
  assert.throws(() => planActiveMotifMove(motifs, "missing", 1));
  assert.throws(() => planActiveMotifMove(motifs, "inactive", 1));
  assert.throws(() => planActiveMotifMove(motifs, "one", 0));
  assert.throws(() => planActiveMotifMove(motifs, "one", 2));
  assert.throws(() => planActiveMotifMove(motifs, "one", 1.5));
});

test("moving to the current position makes no writes for normalized order", () => {
  const plan = planActiveMotifMove([motif("one", 1), motif("two", 2)], "two", 2);
  assert.deepEqual(plan.updates, []);
});
