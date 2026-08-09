const CSP_MODE_VALUES = ["none", "report-only", "enforced"];

export const CSP_MODES = Object.freeze([...CSP_MODE_VALUES]);
export const CSP_HEADER_NAMES = Object.freeze([
  "Content-Security-Policy",
  "Content-Security-Policy-Report-Only",
]);

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const assertStringMap = (value, label) => {
  if (
    !isRecord(value) ||
    Object.entries(value).some(
      ([name, entry]) =>
        typeof name !== "string" ||
        name.length === 0 ||
        typeof entry !== "string" ||
        entry.length === 0,
    )
  ) {
    throw new Error(`${label} must be a non-empty string map`);
  }
  return value;
};

const assertSortedUniqueEnvironmentNames = (value, label) => {
  if (
    !Array.isArray(value) ||
    value.some(
      (name) =>
        typeof name !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} must contain distinct environment names`);
  }
  return [...value].sort();
};

export const assertCspMode = (cspMode) => {
  if (!CSP_MODE_VALUES.includes(cspMode)) {
    throw new Error(`Unsupported CSP delivery mode: ${String(cspMode)}`);
  }
  return cspMode;
};

export const renderCspPolicyValue = (cspPolicy) => {
  if (!isRecord(cspPolicy) || !isRecord(cspPolicy.directives)) {
    throw new Error("CSP delivery requires a directives policy");
  }
  const rendered = Object.entries(cspPolicy.directives).map(
    ([directive, values]) => {
      if (
        !/^[a-z][a-z0-9-]*$/.test(directive) ||
        !Array.isArray(values) ||
        values.length === 0 ||
        values.some(
          (value) =>
            typeof value !== "string" ||
            value.length === 0 ||
            /[;\r\n]/.test(value),
        )
      ) {
        throw new Error(`CSP directive ${directive} is invalid`);
      }
      return `${directive} ${values.join(" ")}`;
    },
  );
  if (rendered.length === 0) {
    throw new Error("CSP delivery requires at least one directive");
  }
  return rendered.join("; ");
};

export const renderCspHeaders = ({ cspMode, cspPolicy }) => {
  const mode = assertCspMode(cspMode);
  const securityHeaders = assertStringMap(
    cspPolicy?.securityHeaders,
    "CSP securityHeaders",
  );
  const cspHeaders =
    mode === "none"
      ? {}
      : {
          [mode === "report-only"
            ? "Content-Security-Policy-Report-Only"
            : "Content-Security-Policy"]: renderCspPolicyValue(cspPolicy),
        };
  return { ...cspHeaders, ...securityHeaders };
};

export const cspReportSinkContract = ({
  cspMode,
  cspPolicy,
  providerPolicy = null,
}) => {
  const mode = assertCspMode(cspMode);
  if (
    typeof cspPolicy?.reportEndpoint !== "string" ||
    !/^\/(?!\/)[^?#]*$/.test(cspPolicy.reportEndpoint)
  ) {
    throw new Error("CSP report endpoint is invalid");
  }
  const enabled = mode !== "none";
  const requiredEnvironmentNames =
    providerPolicy === null
      ? []
      : assertSortedUniqueEnvironmentNames(
          providerPolicy.cspReportEnvironmentNames,
          "providerPolicy.cspReportEnvironmentNames",
        );
  return Object.freeze({
    enabled,
    path: cspPolicy.reportEndpoint,
    functionRoot: enabled ? "api/csp-report.func" : null,
    fallbackDestination: enabled ? null : "/api/not-found",
    requiredEnvironmentNames: enabled ? requiredEnvironmentNames : [],
  });
};

export const resolveProviderEnvironmentContract = (
  providerPolicy,
  cspMode = null,
) => {
  if (!isRecord(providerPolicy)) {
    throw new Error("Provider environment policy is invalid");
  }
  const required = new Set(
    assertSortedUniqueEnvironmentNames(
      providerPolicy.requiredEnvironmentNames,
      "providerPolicy.requiredEnvironmentNames",
    ),
  );
  const forbidden = new Set(
    assertSortedUniqueEnvironmentNames(
      providerPolicy.forbiddenEnvironmentNames,
      "providerPolicy.forbiddenEnvironmentNames",
    ),
  );
  const reportEnvironmentNames = assertSortedUniqueEnvironmentNames(
    providerPolicy.cspReportEnvironmentNames,
    "providerPolicy.cspReportEnvironmentNames",
  );
  for (const name of reportEnvironmentNames) {
    if (required.has(name) || forbidden.has(name)) {
      throw new Error(
        `CSP report environment name must be conditional only: ${name}`,
      );
    }
  }
  if (cspMode !== null && assertCspMode(cspMode) !== "none") {
    for (const name of reportEnvironmentNames) required.add(name);
  }
  for (const name of required) {
    if (forbidden.has(name)) {
      throw new Error(
        `Provider environment name is both required and forbidden: ${name}`,
      );
    }
  }
  return Object.freeze({
    requiredEnvironmentNames: Object.freeze([...required].sort()),
    forbiddenEnvironmentNames: Object.freeze([...forbidden].sort()),
    cspReportEnvironmentNames: Object.freeze(reportEnvironmentNames),
  });
};

const withoutManagedSecurityHeaders = (headers, cspPolicy) => {
  const managedNames = new Set(
    [
      ...CSP_HEADER_NAMES,
      ...Object.keys(
        assertStringMap(cspPolicy.securityHeaders, "CSP securityHeaders"),
      ),
    ].map((name) => name.toLowerCase()),
  );
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !managedNames.has(name.toLowerCase()),
    ),
  );
};

export const renderCspHeaderMap = ({ headers = {}, cspMode, cspPolicy }) => {
  if (!isRecord(headers)) throw new Error("Response headers must be an object");
  return {
    ...withoutManagedSecurityHeaders(headers, cspPolicy),
    ...renderCspHeaders({ cspMode, cspPolicy }),
  };
};

export const renderVercelProjectConfig = ({ config, cspMode, cspPolicy }) => {
  if (!isRecord(config) || !Array.isArray(config.headers)) {
    throw new Error("Vercel project config has no header rules");
  }
  const rendered = structuredClone(config);
  const globalRules = rendered.headers.filter(
    (rule) => rule?.source === "/(.*)" && Array.isArray(rule.headers),
  );
  if (globalRules.length !== 1) {
    throw new Error("Vercel project config requires one global header rule");
  }
  const globalRule = globalRules[0];
  const currentMap = Object.fromEntries(
    globalRule.headers.map((header) => {
      if (typeof header?.key !== "string" || typeof header.value !== "string") {
        throw new Error("Vercel project config contains an invalid header");
      }
      return [header.key, header.value];
    }),
  );
  globalRule.headers = Object.entries(
    renderCspHeaderMap({ headers: currentMap, cspMode, cspPolicy }),
  ).map(([key, value]) => ({ key, value }));
  return rendered;
};

const routeMatches = (route, pathname) => {
  if (typeof route?.src !== "string") return false;
  try {
    return new RegExp(route.src).test(pathname);
  } catch {
    throw new Error(
      `Vercel output contains an invalid route regex: ${route.src}`,
    );
  }
};

const normalizedHeaderMap = (headers) =>
  new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );

export const renderVercelOutputConfig = ({ config, cspMode, cspPolicy }) => {
  if (!isRecord(config) || !Array.isArray(config.routes)) {
    throw new Error("Vercel output config has no routes");
  }
  const filesystemIndex = config.routes.findIndex(
    (route) => route?.handle === "filesystem",
  );
  if (filesystemIndex < 0) {
    throw new Error("Vercel output config has no filesystem boundary");
  }
  const securityHeaders = assertStringMap(
    cspPolicy?.securityHeaders,
    "CSP securityHeaders",
  );
  const candidates = config.routes
    .slice(0, filesystemIndex)
    .map((route, index) => ({ route, index }))
    .filter(({ route }) => {
      if (!isRecord(route?.headers) || !routeMatches(route, "/")) return false;
      const headers = normalizedHeaderMap(route.headers);
      return (
        CSP_HEADER_NAMES.some((name) => headers.has(name.toLowerCase())) ||
        Object.entries(securityHeaders).every(
          ([name, value]) => headers.get(name.toLowerCase()) === value,
        )
      );
    });
  if (candidates.length !== 1) {
    throw new Error(
      "Vercel output requires one global CSP security-header route",
    );
  }
  const rendered = structuredClone(config);
  const candidate = rendered.routes[candidates[0].index];
  candidate.headers = renderCspHeaderMap({
    headers: candidate.headers,
    cspMode,
    cspPolicy,
  });
  return rendered;
};
