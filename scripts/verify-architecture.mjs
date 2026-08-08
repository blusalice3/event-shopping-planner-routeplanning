#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  canonicalize,
  fail,
  normalizePath,
  projectRoot,
  readJson,
  sha256,
  utf8Compare,
  writeJson,
} from "./foundation-policy-utils.mjs";

const writeBaseline = process.argv.includes("--write-baseline");
const policy = await readJson("config/architecture-policy.json");
const excludedPatterns = policy.productionExcludes.map(
  (pattern) => new RegExp(pattern),
);
const allSourceFiles = [];
const sourceFiles = [];
const errors = [];

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(absolutePath);
    } else if (
      entry.isFile() &&
      policy.extensions.includes(path.extname(entry.name))
    ) {
      const displayPath = normalizePath(
        path.relative(projectRoot, absolutePath),
      );
      allSourceFiles.push(displayPath);
      if (!excludedPatterns.some((pattern) => pattern.test(displayPath))) {
        sourceFiles.push(displayPath);
      }
    }
  }
}

for (const root of policy.sourceRoots)
  await collect(path.resolve(projectRoot, root));
allSourceFiles.sort(utf8Compare);
sourceFiles.sort(utf8Compare);
const sourceFileSet = new Set(sourceFiles);
const contractTestFiles = new Set(allSourceFiles);

async function collectContractTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collectContractTests(absolutePath);
    } else if (
      entry.isFile() &&
      policy.contractTestExtensions.includes(path.extname(entry.name))
    ) {
      contractTestFiles.add(
        normalizePath(path.relative(projectRoot, absolutePath)),
      );
    }
  }
}

for (const root of policy.contractTestRoots ?? policy.sourceRoots) {
  await collectContractTests(path.resolve(projectRoot, root));
}

for (const source of sourceFiles) {
  const matchingLayers = policy.layers.filter((layer) =>
    new RegExp(layer.pathRegex).test(source),
  );
  if (matchingLayers.length === 0) {
    errors.push(`${source}: production source is not assigned to a layer`);
  }
}

for (const rule of policy.forbiddenProductionPathRules ?? []) {
  const pathPattern = new RegExp(rule.pathRegex);
  for (const source of sourceFiles) {
    if (pathPattern.test(source)) {
      errors.push(`${rule.id}: forbidden production bridge at ${source}`);
    }
  }
}

const getLineNumber = (source, index) =>
  source.slice(0, index).split("\n").length;

const parseImports = (source) => {
  const imports = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      imports.push({
        specifier: match[1],
        line: getLineNumber(source, match.index ?? 0),
      });
    }
  }
  const unique = new Map();
  for (const entry of imports) {
    unique.set(`${entry.specifier}\0${entry.line}`, entry);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.line - right.line || utf8Compare(left.specifier, right.specifier),
  );
};

const resolveRelativeImport = async (source, specifier) => {
  if (!specifier.startsWith(".")) return null;
  const withoutQuery = specifier.split(/[?#]/u, 1)[0];
  const base = path.resolve(projectRoot, path.dirname(source), withoutQuery);
  const candidates = path.extname(base)
    ? [base]
    : [
        `${base}.ts`,
        `${base}.tsx`,
        path.join(base, "index.ts"),
        path.join(base, "index.tsx"),
      ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        return normalizePath(path.relative(projectRoot, candidate));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return null;
};

const sourceText = new Map();
const graph = new Map();
const importEdges = [];
for (const source of sourceFiles) {
  const text = await readFile(path.resolve(projectRoot, source), "utf8");
  sourceText.set(source, text);
  const resolvedTargets = [];
  for (const imported of parseImports(text)) {
    const target = await resolveRelativeImport(source, imported.specifier);
    if (target !== null && sourceFileSet.has(target))
      resolvedTargets.push(target);
    importEdges.push({
      source,
      specifier: imported.specifier,
      target,
      line: imported.line,
    });
  }
  graph.set(source, [...new Set(resolvedTargets)].sort(utf8Compare));
}

const violations = [];
const addViolation = (value) => {
  const identity = {
    ruleId: value.ruleId,
    source: value.source,
    target: value.target,
    specifier: value.specifier,
    line: value.line,
  };
  violations.push({
    ...identity,
    fingerprint: sha256(canonicalize(identity)),
  });
};

for (const rule of policy.forbiddenImportRules) {
  const sourcePattern = new RegExp(rule.sourceRegex);
  const targetPattern =
    typeof rule.targetRegex === "string" ? new RegExp(rule.targetRegex) : null;
  const packagePattern =
    typeof rule.packageRegex === "string"
      ? new RegExp(rule.packageRegex)
      : null;
  for (const edge of importEdges) {
    if (!sourcePattern.test(edge.source)) continue;
    const violatesTarget =
      targetPattern !== null &&
      edge.target !== null &&
      targetPattern.test(edge.target);
    const violatesPackage =
      packagePattern !== null &&
      !edge.specifier.startsWith(".") &&
      packagePattern.test(edge.specifier);
    if (violatesTarget || violatesPackage) {
      addViolation({
        ruleId: rule.id,
        source: edge.source,
        target: edge.target,
        specifier: edge.specifier,
        line: edge.line,
      });
    }
  }
}

for (const rule of policy.forbiddenTextRules) {
  const sourcePattern = new RegExp(rule.sourceRegex);
  const textPattern = new RegExp(rule.pattern, "gu");
  for (const [source, text] of sourceText) {
    if (!sourcePattern.test(source)) continue;
    for (const match of text.matchAll(textPattern)) {
      addViolation({
        ruleId: rule.id,
        source,
        target: null,
        specifier: match[0],
        line: getLineNumber(text, match.index ?? 0),
      });
    }
  }
}

for (const rule of policy.forbiddenContractTestTextRules ?? []) {
  const sourcePattern = new RegExp(rule.sourceRegex);
  const textPattern = new RegExp(rule.pattern, "gu");
  for (const source of [...contractTestFiles].sort(utf8Compare)) {
    if (!sourcePattern.test(source)) continue;
    const text = await readFile(path.resolve(projectRoot, source), "utf8");
    for (const match of text.matchAll(textPattern)) {
      errors.push(
        `${rule.id}: forbidden source-text contract at ${source}:${getLineNumber(text, match.index ?? 0)}`,
      );
    }
  }
}

for (const rule of policy.entryGraphRules) {
  const forbiddenTarget = new RegExp(rule.forbiddenTargetRegex);
  const queue = [rule.entry];
  const visited = new Set();
  let matchedTarget = null;
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    if (forbiddenTarget.test(current)) {
      matchedTarget = current;
      break;
    }
    for (const target of graph.get(current) ?? []) queue.push(target);
  }
  if (matchedTarget !== null) {
    addViolation({
      ruleId: rule.id,
      source: rule.entry,
      target: matchedTarget,
      specifier: "reachable-entry-graph",
      line: 1,
    });
  }
}

violations.sort(
  (left, right) =>
    utf8Compare(left.ruleId, right.ruleId) ||
    utf8Compare(left.source, right.source) ||
    left.line - right.line ||
    utf8Compare(left.specifier, right.specifier),
);
const graphHash = sha256(
  canonicalize(
    importEdges
      .map(({ source, specifier, target }) => ({ source, specifier, target }))
      .sort(
        (left, right) =>
          utf8Compare(left.source, right.source) ||
          utf8Compare(left.specifier, right.specifier),
      ),
  ),
);

if (errors.length > 0) {
  fail("FAIL architecture policy", errors);
} else if (writeBaseline) {
  const head =
    process.env.GITHUB_SHA ?? "638dc0d2b05a09da9ea09e3f25e00bb36e1b2994";
  const exceptionMetadata = {
    "ui-direct-indexeddb": {
      owner: "App/Persistence",
      reason:
        "Existing monolith edge retained until the Phase 6/7 facade split.",
      expiry: "2027-06-30",
    },
    "ui-direct-xlsx-package": {
      owner: "XLSX/UI",
      reason: "Existing package edge retained until the Phase 3 worker port.",
      expiry: "2027-03-31",
    },
  };
  await writeJson(policy.baseline, {
    schemaVersion: 1,
    measurementSourceSha: head,
    moduleGraphHash: graphHash,
    productionFileCount: sourceFiles.length,
    importEdgeCount: importEdges.length,
    exceptions: violations.map((violation) => ({
      id: `${violation.ruleId}:${violation.fingerprint.slice(0, 16)}`,
      ruleId: violation.ruleId,
      source: violation.source,
      target: violation.target,
      specifier: violation.specifier,
      line: violation.line,
      owner: exceptionMetadata[violation.ruleId]?.owner ?? "Architecture",
      reason:
        exceptionMetadata[violation.ruleId]?.reason ??
        "Existing edge recorded at the Phase 0 architecture baseline.",
      expiry: exceptionMetadata[violation.ruleId]?.expiry ?? "2026-12-31",
      fingerprint: violation.fingerprint,
    })),
  });
  process.stdout.write(
    `WROTE ${policy.baseline}: ${violations.length} baseline exception(s)\n`,
  );
} else {
  const baseline = await readJson(policy.baseline);
  const allowed = new Set(
    baseline.exceptions.map((exception) => exception.fingerprint),
  );
  for (const exception of baseline.exceptions) {
    for (const field of policy.exceptionPolicy.requiredFields) {
      if (
        typeof exception[field] !== "string" ||
        exception[field].length === 0
      ) {
        errors.push(`${exception.id ?? "unknown"}: missing ${field}`);
      }
    }
    if (
      policy.exceptionPolicy.rejectExpired &&
      Date.parse(`${exception.expiry}T00:00:00Z`) <= Date.now()
    ) {
      errors.push(`${exception.id}: architecture exception is expired`);
    }
  }
  for (const violation of violations) {
    if (!allowed.has(violation.fingerprint)) {
      errors.push(
        `${violation.ruleId}: new violation at ${violation.source}:${violation.line} -> ${violation.target ?? violation.specifier}`,
      );
    }
  }
  if (errors.length > 0) {
    fail("FAIL architecture verification", errors);
  } else {
    process.stdout.write(
      `PASS architecture verification: ${sourceFiles.length} production files; ${importEdges.length} import edges; ${violations.length} baseline exception(s); graph ${graphHash}\n`,
    );
  }
}
