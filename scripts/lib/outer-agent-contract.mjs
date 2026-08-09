import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "./canonical-json.mjs";

export const OUTER_AGENT_URL = "/assets/outer-recovery-agent.js";
export const OUTER_AGENT_GRAPH_URL = "/outer-agent-graph.json";
export const OUTER_AGENT_ENTRY_MODULE = "src/pwa/recovery/outerAgentEntry.ts";
export const OUTER_AGENT_BUNDLE_ENV = "FOUNDATION_OUTER_AGENT_BUNDLE_PATH";
export const OUTER_AGENT_GRAPH_ENV = "FOUNDATION_OUTER_AGENT_GRAPH_PATH";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const assertExactKeys = (value, keys, label) => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has an unexpected property set`);
  }
};

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const assertSortedUniqueStrings = (values, label) => {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  let previous = null;
  for (const [index, value] of values.entries()) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\0") ||
      value.includes("\\") ||
      /^(?:[A-Za-z]:\/|\/)/.test(value)
    ) {
      throw new Error(`${label}[${index}] is not a checkout-relative module`);
    }
    if (previous !== null && compareUtf8(previous, value) >= 0) {
      throw new Error(`${label} must use strict UTF-8 byte order`);
    }
    previous = value;
  }
};

const isAllowedOuterModule = (moduleId) =>
  moduleId === "src/pwa/releaseIdentityProtocol.ts" ||
  moduleId.startsWith("src/pwa/recovery/");

export const assertIndependentOuterAgentGraph = ({
  graph,
  sourceSha,
  outerAgentBytes,
}) => {
  if (!Buffer.isBuffer(outerAgentBytes) || outerAgentBytes.length === 0) {
    throw new Error("Independent outer agent bytes are missing or empty");
  }
  assertExactKeys(
    graph,
    [
      "schemaVersion",
      "graphKind",
      "sourceSha",
      "entryModule",
      "entryFile",
      "modules",
      "chunks",
    ],
    "OuterAgentGraph",
  );
  if (
    graph.schemaVersion !== 1 ||
    graph.graphKind !== "single-entry-outer-agent-v1" ||
    !SOURCE_SHA_PATTERN.test(graph.sourceSha ?? "") ||
    graph.sourceSha !== sourceSha ||
    graph.entryModule !== OUTER_AGENT_ENTRY_MODULE ||
    graph.entryFile !== OUTER_AGENT_URL
  ) {
    throw new Error("OuterAgentGraph identity is invalid");
  }
  if (!Array.isArray(graph.modules) || graph.modules.length === 0) {
    throw new Error("OuterAgentGraph modules are missing");
  }
  const moduleIds = [];
  for (const [index, module] of graph.modules.entries()) {
    const label = `OuterAgentGraph.modules[${index}]`;
    assertExactKeys(
      module,
      ["id", "external", "staticImports", "dynamicImports"],
      label,
    );
    assertSortedUniqueStrings([module.id], `${label}.id`);
    if (!isAllowedOuterModule(module.id) || module.external !== false) {
      throw new Error(`${label} leaves the closed outer-agent source graph`);
    }
    assertSortedUniqueStrings(module.staticImports, `${label}.staticImports`);
    assertSortedUniqueStrings(module.dynamicImports, `${label}.dynamicImports`);
    if (module.dynamicImports.length !== 0) {
      throw new Error(`${label} contains a dynamic import`);
    }
    moduleIds.push(module.id);
  }
  assertSortedUniqueStrings(moduleIds, "OuterAgentGraph module IDs");
  if (!moduleIds.includes(OUTER_AGENT_ENTRY_MODULE)) {
    throw new Error("OuterAgentGraph entry module is absent");
  }
  const moduleIdSet = new Set(moduleIds);
  for (const module of graph.modules) {
    for (const imported of module.staticImports) {
      if (!moduleIdSet.has(imported)) {
        throw new Error("OuterAgentGraph imports an absent module");
      }
    }
  }
  if (!Array.isArray(graph.chunks) || graph.chunks.length !== 1) {
    throw new Error("OuterAgentGraph must contain exactly one output chunk");
  }
  const chunk = graph.chunks[0];
  assertExactKeys(
    chunk,
    ["file", "sha256", "size", "staticImports", "dynamicImports", "modules"],
    "OuterAgentGraph.chunks[0]",
  );
  if (
    chunk.file !== OUTER_AGENT_URL ||
    !SHA256_PATTERN.test(chunk.sha256 ?? "") ||
    chunk.sha256 !== sha256Bytes(outerAgentBytes) ||
    chunk.size !== outerAgentBytes.length ||
    !Array.isArray(chunk.staticImports) ||
    chunk.staticImports.length !== 0 ||
    !Array.isArray(chunk.dynamicImports) ||
    chunk.dynamicImports.length !== 0
  ) {
    throw new Error(
      "OuterAgentGraph chunk is not a self-contained byte-exact entry",
    );
  }
  assertSortedUniqueStrings(chunk.modules, "OuterAgentGraph chunk modules");
  if (
    chunk.modules.length !== moduleIds.length ||
    chunk.modules.some((moduleId, index) => moduleId !== moduleIds[index])
  ) {
    throw new Error("OuterAgentGraph chunk module closure differs");
  }
  return graph;
};

export const parseIndependentOuterAgentGraph = ({
  graphBytes,
  sourceSha,
  outerAgentBytes,
}) => {
  if (!Buffer.isBuffer(graphBytes) || graphBytes.length === 0) {
    throw new Error("Independent outer agent graph bytes are missing");
  }
  const graph = parseJsonStrict(
    graphBytes.toString("utf8"),
    "outer-agent-graph.json",
  );
  if (!graphBytes.equals(canonicalJsonBytes(graph))) {
    throw new Error("OuterAgentGraph must use canonical JSON bytes");
  }
  return assertIndependentOuterAgentGraph({
    graph,
    sourceSha,
    outerAgentBytes,
  });
};
