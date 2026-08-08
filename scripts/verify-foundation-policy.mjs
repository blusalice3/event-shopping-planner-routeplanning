import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readJsonStrict, sha256Json } from "./lib/canonical-json.mjs";
import {
  projectContainmentDimensions,
  verifyPhaseSequence,
} from "./lib/release-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDirectory = path.join(root, "config");
const contractDirectory = path.join(root, "contracts");

const jsonFiles = async (directory) =>
  (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right, "en"));

const files = [
  ...(await jsonFiles(configDirectory)),
  ...(await jsonFiles(contractDirectory)),
];
const hashes = {};
for (const file of files) {
  const value = await readJsonStrict(file);
  hashes[path.relative(root, file).replaceAll("\\", "/")] = sha256Json(value);
}

const policy = await readJsonStrict(
  path.join(configDirectory, "release-variants.json"),
);
verifyPhaseSequence(policy);
projectContainmentDimensions(policy, policy.initialStandard);
projectContainmentDimensions(policy, policy.targetStandard);

const providerPolicy = await readJsonStrict(
  path.join(configDirectory, "provider-policy.json"),
);
const stateStorePolicy = await readJsonStrict(
  path.join(configDirectory, "release-state-store.json"),
);
const approvalPolicy = await readJsonStrict(
  path.join(configDirectory, "approval-policy.json"),
);
const dbContract = await readJsonStrict(
  path.join(configDirectory, "db-compatibility-contract.json"),
);

const blockers = [
  ...(policy.activationBlockers ?? []),
  ...(providerPolicy.blockerCodes ?? []),
  ...(stateStorePolicy.blockerCodes ?? []),
  ...(approvalPolicy.blockerCodes ?? []),
  ...(dbContract.blockerCodes ?? []),
];

if (
  process.argv.includes("--require-production-ready") &&
  blockers.length > 0
) {
  throw new Error(
    `Foundation production activation blocked: ${[...new Set(blockers)].join(", ")}`,
  );
}

if (process.argv.includes("--json")) {
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        policyHashes: hashes,
        productionActivationReady: blockers.length === 0,
        blockerCodes: [...new Set(blockers)].sort(),
      },
      null,
      2,
    )}\n`,
  );
} else {
  console.log(
    `PASS foundation policy: ${files.length} JSON files; production activation ${
      blockers.length === 0 ? "ready" : `blocked (${new Set(blockers).size})`
    }.`,
  );
}
