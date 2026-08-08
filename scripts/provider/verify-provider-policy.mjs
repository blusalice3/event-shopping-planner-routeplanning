import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readJsonStrict, sha256Json } from "../lib/canonical-json.mjs";
import {
  assertProviderPolicyConfigured,
  assertVercelObservationEvidence,
} from "./collect-vercel-observation.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const policy = await readJsonStrict(
  path.join(root, "config", "provider-policy.json"),
);
const observationIndex = process.argv.indexOf("--observation");
const utf8Compare = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const assertSortedUniqueStrings = (values, label, allowEmpty = false) => {
  if (
    !Array.isArray(values) ||
    (!allowEmpty && values.length === 0) ||
    values.some((value) => typeof value !== "string" || value.length === 0) ||
    new Set(values).size !== values.length ||
    values.some(
      (value, index) => index > 0 && utf8Compare(values[index - 1], value) >= 0,
    )
  ) {
    throw new Error(`${label} must be UTF-8-byte sorted, distinct strings`);
  }
};

if (
  policy.schemaVersion !== 1 ||
  policy.provider !== "vercel" ||
  policy.providerNodeFamily !== "24.x" ||
  policy.productionEnvironmentName !== "production" ||
  policy.productionBranch !== "main" ||
  policy.autoAssignCustomProductionDomains !== false ||
  policy.gitProductionAutoDeploy !== false ||
  policy.hstsOwner !== "provider" ||
  policy.observationPolicy?.apiBaseUrl !== "https://api.vercel.com" ||
  policy.observationPolicy?.firewallConfigVersion !== "active" ||
  !Number.isSafeInteger(policy.observationPolicy?.maxResponseAgeSeconds) ||
  !Number.isSafeInteger(policy.observationPolicy?.maxFutureClockSkewSeconds) ||
  typeof policy.observationPolicy?.requireEtag !== "boolean"
) {
  throw new Error("Provider policy static identity is invalid");
}
assertSortedUniqueStrings(
  policy.ownedProductionDomains,
  "ownedProductionDomains",
  policy.bindingStatus !== "configured",
);
assertSortedUniqueStrings(
  [...policy.requiredEnvironmentNames].sort(utf8Compare),
  "requiredEnvironmentNames",
);
assertSortedUniqueStrings(
  [...policy.forbiddenEnvironmentNames].sort(utf8Compare),
  "forbiddenEnvironmentNames",
);
assertSortedUniqueStrings(
  policy.allowedPreviewBranches,
  "allowedPreviewBranches",
  true,
);
assertSortedUniqueStrings(
  [...policy.requiredConfigurationEvidence].sort(utf8Compare),
  "requiredConfigurationEvidence",
);
if (
  policy.allowedPreviewBranches.includes(policy.productionBranch) ||
  policy.requiredEnvironmentNames.some((name) =>
    policy.forbiddenEnvironmentNames.includes(name),
  ) ||
  !Number.isSafeInteger(
    policy.rawRequestByteCeilings?.persistenceReleaseAMetrics,
  ) ||
  policy.rawRequestByteCeilings.persistenceReleaseAMetrics !== 1024
) {
  throw new Error("Provider environment or request-ceiling policy is invalid");
}

if (observationIndex !== -1 || process.argv.includes("--require-configured")) {
  assertProviderPolicyConfigured(policy);
}

if (observationIndex !== -1) {
  const observationPath = process.argv[observationIndex + 1];
  if (!observationPath) throw new Error("--observation requires a file");
  const observed = await readJsonStrict(path.resolve(observationPath));
  assertVercelObservationEvidence(observed, policy);
  const expectedDomains = [...policy.ownedProductionDomains];
  const observedDomains = [...(observed.ownedProductionDomains ?? [])];
  assertSortedUniqueStrings(observedDomains, "observed ownedProductionDomains");
  assertSortedUniqueStrings(
    [...(observed.presentEnvironmentNames ?? [])].sort(utf8Compare),
    "observed environment names",
    true,
  );
  const requiredEnvironmentNames = new Set(policy.requiredEnvironmentNames);
  const presentEnvironmentNames = new Set(
    observed.presentEnvironmentNames ?? [],
  );
  const forbiddenEnvironmentNames = new Set(policy.forbiddenEnvironmentNames);

  const mismatches = [];
  const requireEqual = (label, actual, expected) => {
    if (actual !== expected) mismatches.push(label);
  };
  requireEqual(
    "providerProjectId",
    observed.providerProjectId,
    policy.expectedProjectId,
  );
  requireEqual(
    "providerTeamId",
    observed.providerTeamId,
    policy.expectedTeamId,
  );
  requireEqual(
    "productionEnvironmentName",
    observed.productionEnvironmentName,
    policy.productionEnvironmentName,
  );
  requireEqual(
    "providerNodeFamily",
    observed.providerNodeFamily,
    policy.providerNodeFamily,
  );
  requireEqual(
    "productionBranch",
    observed.productionBranch,
    policy.productionBranch,
  );
  requireEqual(
    "autoAssignCustomProductionDomains",
    observed.autoAssignCustomProductionDomains,
    policy.autoAssignCustomProductionDomains,
  );
  requireEqual(
    "gitProductionAutoDeploy",
    observed.gitProductionAutoDeploy,
    policy.gitProductionAutoDeploy,
  );
  requireEqual("gitPreviewAutoDeploy", observed.gitPreviewAutoDeploy, false);
  requireEqual("hstsOwner", observed.hstsOwner, policy.hstsOwner);
  if (
    sha256Json(observed.allowedPreviewBranches ?? []) !==
      sha256Json(policy.allowedPreviewBranches) ||
    sha256Json(observed.rawRequestByteCeilings ?? {}) !==
      sha256Json(policy.rawRequestByteCeilings) ||
    sha256Json(observed.wafRules) !== sha256Json(policy.wafRules) ||
    sha256Json(observed.logPolicy) !== sha256Json(policy.logPolicy) ||
    sha256Json(observed.hstsPolicy) !== sha256Json(policy.hstsPolicy)
  ) {
    mismatches.push("provider-configuration");
  }
  if (
    sha256Json(
      [...(observed.configurationEvidenceKinds ?? [])].sort(utf8Compare),
    ) !==
    sha256Json([...policy.requiredConfigurationEvidence].sort(utf8Compare))
  ) {
    mismatches.push("configurationEvidenceKinds");
  }
  if (
    expectedDomains.length !== observedDomains.length ||
    expectedDomains.some((domain, index) => domain !== observedDomains[index])
  ) {
    mismatches.push("ownedProductionDomains");
  }
  for (const name of requiredEnvironmentNames) {
    if (!presentEnvironmentNames.has(name)) {
      mismatches.push(`missing-environment:${name}`);
    }
  }
  for (const name of forbiddenEnvironmentNames) {
    if (presentEnvironmentNames.has(name)) {
      mismatches.push(`forbidden-environment:${name}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Provider policy drift: ${mismatches.join(", ")}`);
  }
  console.log(
    `PASS provider policy observation: ${observed.providerProjectId}; ${observedDomains.length} domains; configuration ${sha256Json(observed)}.`,
  );
} else {
  console.log(
    `PASS provider policy structure ${sha256Json(policy)}; binding ${policy.bindingStatus}.`,
  );
}
