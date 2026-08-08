import path from "node:path";

const normalizeSlashes = (value) => value.replaceAll("\\", "/");

export const normalizeCoveragePath = (value, projectRoot) => {
  const normalizedValue = normalizeSlashes(value).replace(/^\.\//, "");
  const normalizedRoot = normalizeSlashes(path.resolve(projectRoot));
  if (
    normalizedValue === normalizedRoot ||
    normalizedValue.startsWith(`${normalizedRoot}/`)
  ) {
    return normalizedValue.slice(normalizedRoot.length + 1);
  }
  return normalizedValue;
};

const createFileCoverage = () => ({
  branches: new Map(),
  functions: new Map(),
  lines: new Map(),
});

const commitRecord = (records, record, functionLocations, functionHits) => {
  if (record === undefined) return;
  for (const [name, line] of functionLocations) {
    record.functions.set(`${line}:${name}`, functionHits.get(name) ?? 0);
  }
  records.set(record.path, record);
};

export const parseLcov = (source, projectRoot) => {
  const records = new Map();
  let record;
  let functionHits = new Map();
  let functionLocations = new Map();

  for (const rawLine of source.split(/\r?\n/u)) {
    if (rawLine.startsWith("SF:")) {
      commitRecord(records, record, functionLocations, functionHits);
      const filePath = normalizeCoveragePath(rawLine.slice(3), projectRoot);
      record = { ...createFileCoverage(), path: filePath };
      functionHits = new Map();
      functionLocations = new Map();
      continue;
    }
    if (record === undefined) continue;

    if (rawLine.startsWith("DA:")) {
      const [line, hits] = rawLine.slice(3).split(",", 2).map(Number);
      if (Number.isSafeInteger(line) && Number.isFinite(hits)) {
        record.lines.set(line, hits);
      }
      continue;
    }
    if (rawLine.startsWith("BRDA:")) {
      const [lineValue, block, branch, hitsValue] = rawLine
        .slice(5)
        .split(",", 4);
      const line = Number(lineValue);
      const hits = hitsValue === "-" ? 0 : Number(hitsValue);
      if (Number.isSafeInteger(line) && Number.isFinite(hits)) {
        record.branches.set(`${line}:${block}:${branch}`, { hits, line });
      }
      continue;
    }
    if (rawLine.startsWith("FN:")) {
      const separator = rawLine.indexOf(",", 3);
      if (separator > 3) {
        const line = Number(rawLine.slice(3, separator));
        const name = rawLine.slice(separator + 1);
        if (Number.isSafeInteger(line) && name.length > 0) {
          functionLocations.set(name, line);
        }
      }
      continue;
    }
    if (rawLine.startsWith("FNDA:")) {
      const separator = rawLine.indexOf(",", 5);
      if (separator > 5) {
        const hits = Number(rawLine.slice(5, separator));
        const name = rawLine.slice(separator + 1);
        if (Number.isFinite(hits) && name.length > 0) {
          functionHits.set(name, hits);
        }
      }
      continue;
    }
    if (rawLine === "end_of_record") {
      commitRecord(records, record, functionLocations, functionHits);
      record = undefined;
      functionHits = new Map();
      functionLocations = new Map();
    }
  }

  commitRecord(records, record, functionLocations, functionHits);
  return records;
};

const mergeMetricMap = (target, source) => {
  for (const [key, value] of source) {
    if (typeof value === "number") {
      target.set(key, Math.max(target.get(key) ?? 0, value));
    } else {
      const previous = target.get(key);
      target.set(key, {
        ...value,
        hits: Math.max(previous?.hits ?? 0, value.hits),
      });
    }
  }
};

export const mergeCoverageRecords = (...reports) => {
  const merged = new Map();
  for (const report of reports) {
    for (const [filePath, fileCoverage] of report) {
      const target = merged.get(filePath) ?? createFileCoverage();
      mergeMetricMap(target.lines, fileCoverage.lines);
      mergeMetricMap(target.branches, fileCoverage.branches);
      mergeMetricMap(target.functions, fileCoverage.functions);
      merged.set(filePath, target);
    }
  }
  return merged;
};

export const pathMatchesScope = (filePath, scope) =>
  scope.files.includes(filePath) ||
  scope.prefixes.some((prefix) => filePath.startsWith(prefix));

export const isCoverageSourcePath = (filePath) =>
  /\.(?:mjs|ts|tsx)$/u.test(filePath) &&
  !/\.(?:integration\.|worker\.)?test\.(?:mjs|ts|tsx)$/u.test(filePath) &&
  !filePath.endsWith(".d.ts") &&
  !filePath.includes("_backup.");

const metricRate = (covered, total) =>
  total === 0 ? undefined : (covered / total) * 100;

export const summarizeCoverage = (records, scope) => {
  const selected = [...records.entries()].filter(([filePath]) =>
    pathMatchesScope(filePath, scope),
  );
  const totals = {
    branches: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
    lines: { covered: 0, total: 0 },
  };

  for (const [, coverage] of selected) {
    for (const hits of coverage.lines.values()) {
      totals.lines.total += 1;
      if (hits > 0) totals.lines.covered += 1;
    }
    for (const branch of coverage.branches.values()) {
      totals.branches.total += 1;
      if (branch.hits > 0) totals.branches.covered += 1;
    }
    for (const hits of coverage.functions.values()) {
      totals.functions.total += 1;
      if (hits > 0) totals.functions.covered += 1;
    }
  }

  return {
    files: selected.map(([filePath]) => filePath).sort(),
    branches: {
      ...totals.branches,
      rate: metricRate(totals.branches.covered, totals.branches.total),
    },
    functions: {
      ...totals.functions,
      rate: metricRate(totals.functions.covered, totals.functions.total),
    },
    lines: {
      ...totals.lines,
      rate: metricRate(totals.lines.covered, totals.lines.total),
    },
  };
};

export const parseUnifiedDiff = (source) => {
  const changedLines = new Map();
  let currentFile;

  for (const line of source.split(/\r?\n/u)) {
    if (line.startsWith("+++ ")) {
      const candidate = normalizeSlashes(line.slice(4));
      currentFile =
        candidate === "/dev/null"
          ? undefined
          : candidate.replace(/^(?:a|b)\//u, "");
      continue;
    }
    if (currentFile === undefined || !line.startsWith("@@")) continue;
    const match = line.match(/\+(\d+)(?:,(\d+))?\s/u);
    if (match === null) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    const lines = changedLines.get(currentFile) ?? new Set();
    for (let offset = 0; offset < count; offset += 1) {
      lines.add(start + offset);
    }
    changedLines.set(currentFile, lines);
  }

  return changedLines;
};

export const mergeChangedLines = (...changes) => {
  const merged = new Map();
  for (const change of changes) {
    for (const [filePath, lines] of change) {
      const target = merged.get(filePath) ?? new Set();
      for (const line of lines) target.add(line);
      merged.set(filePath, target);
    }
  }
  return merged;
};

export const summarizeChangedCoverage = (records, changedLines, scope) => {
  const summary = {
    branches: { covered: 0, total: 0 },
    changedFiles: [],
    lines: { covered: 0, total: 0 },
    missingFiles: [],
  };

  for (const [filePath, lines] of changedLines) {
    if (!pathMatchesScope(filePath, scope) || !isCoverageSourcePath(filePath)) {
      continue;
    }
    summary.changedFiles.push(filePath);
    const coverage = records.get(filePath);
    if (coverage === undefined) {
      summary.missingFiles.push(filePath);
      continue;
    }
    for (const line of lines) {
      const hits = coverage.lines.get(line);
      if (hits !== undefined) {
        summary.lines.total += 1;
        if (hits > 0) summary.lines.covered += 1;
      }
      for (const branch of coverage.branches.values()) {
        if (branch.line !== line) continue;
        summary.branches.total += 1;
        if (branch.hits > 0) summary.branches.covered += 1;
      }
    }
  }

  summary.changedFiles.sort();
  summary.missingFiles.sort();
  return {
    ...summary,
    branches: {
      ...summary.branches,
      rate: metricRate(summary.branches.covered, summary.branches.total),
    },
    lines: {
      ...summary.lines,
      rate: metricRate(summary.lines.covered, summary.lines.total),
    },
  };
};

export const formatRate = (metric) =>
  metric.rate === undefined
    ? "n/a"
    : `${metric.rate.toFixed(2)}% (${metric.covered}/${metric.total})`;
