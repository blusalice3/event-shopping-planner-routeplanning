export const PERFORMANCE_SAMPLE_COUNT = 30;
export const PERFORMANCE_WARMUP_COUNT = 1;
export const PERFORMANCE_ROTATION = "left-rotate-by-sample-index-v1";

const dispatchEntries = [
  ["foundation-startup-cold", "P0-TOOLCHAIN", "foundation-browser"],
  ["foundation-startup-warm", "P0-TOOLCHAIN", "foundation-browser"],
  ["foundation-full-list", "P0-TOOLCHAIN", "foundation-browser"],
  ["foundation-benign-main-thread-xlsx", "P0-TOOLCHAIN", "foundation-browser"],
  ["foundation-indexeddb-current", "P0-TOOLCHAIN", "foundation-browser"],
  ["xlsx-worker-import-valid", "P3-XLSX", "xlsx-worker-browser"],
  ["xlsx-worker-export-roundtrip", "P3-XLSX", "xlsx-worker-browser"],
  ["xlsx-worker-reject-corrupt", "P3-XLSX", "xlsx-worker-browser"],
  ["xlsx-worker-reject-input-over-limit", "P3-XLSX", "xlsx-worker-browser"],
  ["xlsx-worker-reject-zip-bomb", "P3-XLSX", "xlsx-worker-browser"],
  ["xlsx-worker-cancel", "P3-XLSX", "xlsx-worker-browser"],
  ["xlsx-worker-timeout", "P3-XLSX", "xlsx-worker-browser"],
  ["list-long-full", "P5-DUAL", "shopping-list-browser"],
  ["list-long-virtual", "P5-DUAL", "shopping-list-browser"],
  ["list-virtual-scroll-anchor", "P5-DUAL", "shopping-list-browser"],
  ["list-virtual-focus-interaction", "P5-DUAL", "shopping-list-browser"],
  ["list-renderer-selection", "P5-LIST", "shopping-list-browser"],
];

export const CANONICAL_SCENARIO_DISPATCH = Object.freeze(
  Object.fromEntries(
    dispatchEntries.map(([id, gate, adapterKind]) => [
      id,
      Object.freeze({ adapterKind, gate, id }),
    ]),
  ),
);

export const CANONICAL_SCENARIO_IDS = Object.freeze(
  dispatchEntries.map(([id]) => id),
);

export const REQUIRED_PERFORMANCE_VARIANTS = Object.freeze({
  "P0-TOOLCHAIN": Object.freeze({
    releaseRole: "standard",
    xlsxExecution: "main",
    listEngine: "full",
    listDefault: "full",
  }),
  "P3-XLSX": Object.freeze({
    releaseRole: "standard",
    xlsxExecution: "worker",
    listEngine: "full",
    listDefault: "full",
  }),
  "P5-DUAL": Object.freeze({
    releaseRole: "standard",
    xlsxExecution: "worker",
    listEngine: "dual",
    listDefault: "full",
  }),
  "P5-LIST": Object.freeze({
    releaseRole: "standard",
    xlsxExecution: "worker",
    listEngine: "dual",
    listDefault: "auto",
  }),
  "P8-CLEAN": Object.freeze({
    releaseRole: "standard",
    xlsxExecution: "worker",
    listEngine: "dual",
    listDefault: "auto",
  }),
});
