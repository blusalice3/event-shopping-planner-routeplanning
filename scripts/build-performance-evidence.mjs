import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeJson, readJsonStrict } from "./lib/canonical-json.mjs";
import { buildPerformanceEvidenceEnvelope } from "./lib/performance-evidence-builder.mjs";
import { verifyPerformancePolicy } from "./verify-performance-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const parseArguments = (argv) => {
  const parsed = { input: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") {
      parsed.input = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--output") {
      parsed.output = argv[index + 1] ?? null;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (parsed.input === null || parsed.output === null) {
    throw new Error(
      "Usage: --input <raw-samples.json> --output <evidence.json>",
    );
  }
  return parsed;
};

const main = async () => {
  const arguments_ = parseArguments(process.argv.slice(2));
  const [input, context] = await Promise.all([
    readJsonStrict(path.resolve(arguments_.input)),
    verifyPerformancePolicy({ root }),
  ]);
  const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const treeStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (treeStatus !== "") {
    throw new Error("Performance evidence must be generated from a clean tree");
  }
  if (input.source?.gitCommitSha !== currentCommit) {
    throw new Error("Raw samples are not bound to the current Git commit");
  }
  const envelope = buildPerformanceEvidenceEnvelope({ context, input });
  await writeFile(
    path.resolve(arguments_.output),
    `${canonicalizeJson(envelope)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  process.stdout.write(
    `Wrote ${input.gate} performance evidence ${envelope.evidenceSha256}\n`,
  );
};

await main();
