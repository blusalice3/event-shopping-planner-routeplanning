import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJsonStrict } from "../lib/canonical-json.mjs";
import { collectJsonSchemaErrors } from "./releaseStateSchema.mjs";

const contractDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "contracts",
);

const [
  continuousSourceSchema,
  companionSourceSchema,
  continuousEvidenceSchema,
  companionEvidenceSchema,
] = await Promise.all(
  [
    "continuous-production-probe-source-v2.schema.json",
    "companion-recovery-drill-source-v2.schema.json",
    "continuous-production-probe-v1.schema.json",
    "companion-recovery-drill-v1.schema.json",
  ].map((fileName) => readJsonStrict(path.join(contractDirectory, fileName))),
);

const assertSchema = (value, schema, label) => {
  const errors = collectJsonSchemaErrors(value, schema);
  if (errors.length > 0) {
    throw new Error(
      `${label} schema mismatch: ${errors.slice(0, 8).join("; ")}`,
    );
  }
  return value;
};

export const assertContinuousProbeSourceSchema = (value) =>
  assertSchema(value, continuousSourceSchema, "Continuous probe source v2");

export const assertCompanionRecoverySourceSchema = (value) =>
  assertSchema(value, companionSourceSchema, "Companion recovery source v2");

export const assertContinuousProbeEvidenceSchema = (value) =>
  assertSchema(value, continuousEvidenceSchema, "Continuous probe evidence v1");

export const assertCompanionRecoveryEvidenceSchema = (value) =>
  assertSchema(
    value,
    companionEvidenceSchema,
    "Companion recovery evidence v1",
  );

export const acceptanceEvidenceSchemas = Object.freeze({
  companionEvidence: companionEvidenceSchema,
  companionSource: companionSourceSchema,
  continuousEvidence: continuousEvidenceSchema,
  continuousSource: continuousSourceSchema,
});
