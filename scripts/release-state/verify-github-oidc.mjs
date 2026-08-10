#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readJsonStrict, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  requestGitHubOidcToken,
  verifyGitHubOidcTokenFromIssuer,
} from "./githubOidc.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
};
const sourceSha = argument("--source-sha");
const runId = argument("--run-id");
const output = argument("--output");
const recognized = new Set([
  "--source-sha",
  sourceSha,
  "--run-id",
  runId,
  "--output",
  output,
]);
const unexpected = process.argv
  .slice(2)
  .filter((value) => !recognized.has(value));
if (
  !sourceSha ||
  !runId ||
  !output ||
  unexpected.length > 0 ||
  !/^[0-9a-f]{40}$/.test(sourceSha) ||
  !/^[1-9][0-9]*$/.test(runId)
) {
  throw new Error(
    "Usage: verify-github-oidc.mjs --source-sha <sha> --run-id <id> --output <new-file>",
  );
}
const policy = await readJsonStrict(
  path.join(root, "config", "approval-policy.json"),
);
if (policy.bindingStatus !== "configured") {
  throw new Error(
    `Approval policy is not configured: ${(policy.blockerCodes ?? []).join(", ")}`,
  );
}
const token = await requestGitHubOidcToken({
  requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
  requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  audience: policy.oidcAudience,
});
const verified = await verifyGitHubOidcTokenFromIssuer({
  token,
  policy,
  expectedSourceSha: sourceSha,
  expectedRunId: runId,
});
const outputPath = path.resolve(output);
await writeFile(outputPath, verified.receiptBytes, {
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(
  `PASS GitHub OIDC issuer receipt: ${sha256Bytes(verified.receiptBytes)}\n`,
);
