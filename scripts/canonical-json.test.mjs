import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeJson,
  parseJsonStrict,
  sha256Json,
} from "./lib/canonical-json.mjs";

test("uses RFC 8785-compatible key ordering and number serialization", () => {
  const value = {
    z: "終",
    a: -0,
    nested: { beta: 2, alpha: 1 },
    array: [true, null, "日本語"],
  };
  assert.equal(
    canonicalizeJson(value),
    '{"a":0,"array":[true,null,"日本語"],"nested":{"alpha":1,"beta":2},"z":"終"}',
  );
  assert.match(sha256Json(value), /^[0-9a-f]{64}$/);
});

test("rejects values outside the strict plain-JSON contract", () => {
  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    undefined,
    { missing: undefined },
    new Date(0),
  ]) {
    assert.throws(() => canonicalizeJson(value));
  }
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalizeJson(cyclic), /cyclic/);
});

test("rejects a BOM while accepting canonicalizable parsed JSON", () => {
  assert.deepEqual(parseJsonStrict('{"b":2,"a":1}'), { b: 2, a: 1 });
  assert.throws(() => parseJsonStrict('\uFEFF{"a":1}'), /BOM/);
});
