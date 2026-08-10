import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readAndVerifyExternalPrerequisitePolicy } from "./lib/phase-exit-external-prerequisites.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultPolicyPath = path.join(
  root,
  "config",
  "phase-exit-external-prerequisites.json",
);

const parseArguments = (arguments_) => {
  const options = {
    json: false,
    requireConfigured: false,
    policyPath: defaultPolicyPath,
  };
  const seen = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!["--json", "--policy", "--require-configured"].includes(argument)) {
      throw new Error(
        `Unknown external prerequisite verifier argument: ${argument}`,
      );
    }
    if (seen.has(argument)) {
      throw new Error(
        `Duplicate external prerequisite verifier argument: ${argument}`,
      );
    }
    seen.add(argument);
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--require-configured") {
      options.requireConfigured = true;
    } else {
      const value = arguments_[index + 1];
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.startsWith("--")
      ) {
        throw new Error("--policy requires one explicit file path");
      }
      options.policyPath = path.resolve(process.cwd(), value);
      index += 1;
    }
  }
  return Object.freeze(options);
};

const options = parseArguments(process.argv.slice(2));
const { report } = await readAndVerifyExternalPrerequisitePolicy(
  options.policyPath,
);
if (options.requireConfigured && report.activationStatus !== "configured") {
  throw new Error(
    `External phase-exit prerequisites remain unconfigured: ${report.blockerCodes.join(", ")}`,
  );
}
if (options.json) {
  console.log(JSON.stringify(report));
} else {
  console.log(
    `PASS external phase-exit prerequisite policy ${report.policySha256}; activation ${report.activationStatus}; blockers ${report.blockerCodes.length}.`,
  );
}
