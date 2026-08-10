export type CspMode = "none" | "report-only" | "enforced";

export type CspPolicy = {
  readonly reportEndpoint: string;
  readonly directives: Readonly<Record<string, readonly string[]>>;
  readonly securityHeaders: Readonly<Record<string, string>>;
};

export declare const CSP_MODES: readonly CspMode[];
export declare const CSP_HEADER_NAMES: readonly [
  "Content-Security-Policy",
  "Content-Security-Policy-Report-Only",
];
export declare const assertCspMode: (cspMode: unknown) => CspMode;
export declare const renderCspPolicyValue: (cspPolicy: CspPolicy) => string;
export declare const renderCspHeaders: (options: {
  cspMode: CspMode;
  cspPolicy: CspPolicy;
}) => Record<string, string>;
export declare const cspReportSinkContract: (options: {
  cspMode: CspMode;
  cspPolicy: CspPolicy;
  providerPolicy?: Record<string, unknown> | null;
}) => {
  readonly enabled: boolean;
  readonly path: string;
  readonly functionRoot: "api/csp-report.func" | null;
  readonly fallbackDestination: "/api/not-found" | null;
  readonly requiredEnvironmentNames: readonly string[];
};
export declare const resolveProviderEnvironmentContract: (
  providerPolicy: Record<string, unknown>,
  cspMode?: CspMode | null,
) => {
  readonly requiredEnvironmentNames: readonly string[];
  readonly forbiddenEnvironmentNames: readonly string[];
  readonly cspReportEnvironmentNames: readonly string[];
};
export declare const renderCspHeaderMap: (options: {
  headers?: Record<string, string>;
  cspMode: CspMode;
  cspPolicy: CspPolicy;
}) => Record<string, string>;
export declare const renderVercelProjectConfig: (options: {
  config: Record<string, unknown>;
  cspMode: CspMode;
  cspPolicy: CspPolicy;
}) => Record<string, unknown>;
export declare const renderVercelOutputConfig: (options: {
  config: Record<string, unknown>;
  cspMode: CspMode;
  cspPolicy: CspPolicy;
}) => Record<string, unknown>;
