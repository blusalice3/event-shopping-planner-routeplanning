export declare const OUTER_AGENT_URL: "/assets/outer-recovery-agent.js";
export declare const OUTER_AGENT_GRAPH_URL: "/outer-agent-graph.json";
export declare const OUTER_AGENT_ENTRY_MODULE: "src/pwa/recovery/outerAgentEntry.ts";
export declare const OUTER_AGENT_BUNDLE_ENV: "FOUNDATION_OUTER_AGENT_BUNDLE_PATH";
export declare const OUTER_AGENT_GRAPH_ENV: "FOUNDATION_OUTER_AGENT_GRAPH_PATH";

export type OuterAgentGraph = Readonly<{
  schemaVersion: 1;
  graphKind: "single-entry-outer-agent-v1";
  sourceSha: string;
  entryModule: typeof OUTER_AGENT_ENTRY_MODULE;
  entryFile: typeof OUTER_AGENT_URL;
  modules: ReadonlyArray<{
    id: string;
    external: false;
    staticImports: readonly string[];
    dynamicImports: readonly string[];
  }>;
  chunks: readonly [
    {
      file: typeof OUTER_AGENT_URL;
      sha256: string;
      size: number;
      staticImports: readonly [];
      dynamicImports: readonly [];
      modules: readonly string[];
    },
  ];
}>;

export declare const assertIndependentOuterAgentGraph: (input: {
  graph: unknown;
  sourceSha: string;
  outerAgentBytes: Buffer;
}) => OuterAgentGraph;

export declare const parseIndependentOuterAgentGraph: (input: {
  graphBytes: Buffer;
  sourceSha: string;
  outerAgentBytes: Buffer;
}) => OuterAgentGraph;
