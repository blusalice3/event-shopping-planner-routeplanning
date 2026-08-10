import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { collectJsonSchemaErrors } from "./releaseStateSchema.mjs";

const companionSchema = JSON.parse(
  await readFile(
    new URL(
      "../../contracts/companion-recovery-drill-v1.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const eventReference = `release-state://abc/events/1/${"a".repeat(64)}`;
const recoverySteps = [
  {
    step: "package-redeploy-without-rebuild",
    status: "PASS",
    evidenceRef: eventReference,
  },
  {
    step: "independent-companion-probe",
    status: "PASS",
    evidenceRef: eventReference,
  },
  {
    step: "standard-return",
    status: "PASS",
    evidenceRef: eventReference,
  },
];

test("enforces maxLength as Unicode code points on formal identifiers", () => {
  const identifierSchema = companionSchema.$defs.identifier;

  assert.deepEqual(
    collectJsonSchemaErrors("x".repeat(255), identifierSchema, companionSchema),
    [],
  );
  assert.match(
    collectJsonSchemaErrors(
      "x".repeat(256),
      identifierSchema,
      companionSchema,
      "$.operationId",
    ).join("; "),
    /\$\.operationId must contain at most 255 characters/,
  );
  assert.deepEqual(
    collectJsonSchemaErrors("😀", { type: "string", maxLength: 1 }),
    [],
  );
});

test("enforces ordered prefixItems from the companion recovery contract", () => {
  const stepsSchema = companionSchema.properties.steps;

  assert.deepEqual(
    collectJsonSchemaErrors(
      recoverySteps,
      stepsSchema,
      companionSchema,
      "$.steps",
    ),
    [],
  );
  const reordered = [recoverySteps[1], recoverySteps[0], recoverySteps[2]];
  const errors = collectJsonSchemaErrors(
    reordered,
    stepsSchema,
    companionSchema,
    "$.steps",
  );
  assert.ok(errors.some((error) => error.startsWith("$.steps[0].step")));
  assert.ok(errors.some((error) => error.startsWith("$.steps[1].step")));
});

test("enforces boolean items false after the declared tuple prefix", () => {
  const tupleSchema = {
    type: "array",
    prefixItems: [{ const: "first" }, { const: "second" }],
    items: false,
  };

  assert.deepEqual(
    collectJsonSchemaErrors(["first", "second"], tupleSchema),
    [],
  );
  assert.match(
    collectJsonSchemaErrors(
      ["first", "second", "extra"],
      tupleSchema,
      tupleSchema,
      "$.steps",
    ).join("; "),
    /\$\.steps\[2\] is forbidden by the schema/,
  );
});

test("resolves boolean schemas through local references fail-closed", () => {
  const rootSchema = { $defs: { forbidden: false } };
  assert.deepEqual(
    collectJsonSchemaErrors(
      "value",
      { $ref: "#/$defs/forbidden" },
      rootSchema,
      "$.value",
    ),
    ["$.value is forbidden by the schema"],
  );
});
