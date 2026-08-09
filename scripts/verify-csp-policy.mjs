import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CSP_BLOCKED_TARGET_VALUES,
  CSP_EFFECTIVE_DIRECTIVE_VALUES,
  CSP_REPORT_BLOCKED_TARGET_COLUMN,
  normalizeEffectiveDirective,
} from "../api/csp-report.mjs";
import { readJsonStrict } from "./lib/canonical-json.mjs";
import {
  renderCspHeaders,
  renderVercelProjectConfig,
} from "./lib/csp-delivery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const [policy, vercelConfig, indexHtml, cspReportApi, cspContractMigration] =
  await Promise.all([
    readJsonStrict(path.join(root, "config", "csp-policy.json")),
    readJsonStrict(path.join(root, "vercel.json")),
    readFile(path.join(root, "index.html"), "utf8"),
    readFile(path.join(root, "api", "csp-report.mjs"), "utf8"),
    readFile(
      path.join(
        root,
        "supabase",
        "migrations",
        "20260808000000_csp_report_contract.sql",
      ),
      "utf8",
    ),
  ]);

const productionSources = [];

const collectProductionSources = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectProductionSources(absolutePath);
      continue;
    }
    if (
      entry.isFile() &&
      /\.(?:ts|tsx)$/.test(entry.name) &&
      !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name) &&
      !/\.d\.ts$/.test(entry.name)
    ) {
      productionSources.push(absolutePath);
    }
  }
};

const fail = (message) => {
  throw new Error(`CSP policy verification failed: ${message}`);
};

if (
  policy?.schemaVersion !== 1 ||
  typeof policy.policyId !== "string" ||
  policy.policyId.length === 0 ||
  policy.directives === null ||
  typeof policy.directives !== "object" ||
  Array.isArray(policy.directives)
) {
  fail("config/csp-policy.json has an invalid contract");
}

const expectedEffectiveDirectiveValues = [
  "base-uri",
  "child-src",
  "connect-src",
  "default-src",
  "font-src",
  "form-action",
  "frame-ancestors",
  "frame-src",
  "img-src",
  "manifest-src",
  "media-src",
  "object-src",
  "script-src",
  "script-src-attr",
  "script-src-elem",
  "style-src",
  "style-src-attr",
  "style-src-elem",
  "worker-src",
  "unknown",
];
const expectedBlockedTargetValues = [
  "self",
  "scheme",
  "same-site",
  "cross-site",
  "unknown",
];
const readNamedCheckValues = (constraintName, columnName) => {
  const escapedConstraintName = constraintName.replaceAll("_", "\\_");
  const escapedColumnName = columnName.replaceAll("_", "\\_");
  const constraint = cspContractMigration.match(
    new RegExp(
      `\\badd\\s+constraint\\s+${escapedConstraintName}\\s+check\\s*\\(\\s*${escapedColumnName}\\s+in\\s*\\(([\\s\\S]*?)\\)\\s*\\)`,
      "i",
    ),
  );
  return constraint
    ? [...constraint[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
    : [];
};
const sqlEffectiveDirectiveValues = readNamedCheckValues(
  "csp_violation_reports_effective_directive_check",
  "effective_directive",
);
const sqlBlockedTargetValues = readNamedCheckValues(
  "csp_violation_reports_blocked_target_check",
  "blocked_target",
);
const sameOrderedValues = (actual, expected) =>
  actual.length === expected.length &&
  actual.every((value, index) => value === expected[index]);
if (
  !sameOrderedValues(
    CSP_EFFECTIVE_DIRECTIVE_VALUES,
    expectedEffectiveDirectiveValues,
  ) ||
  !sameOrderedValues(
    sqlEffectiveDirectiveValues,
    expectedEffectiveDirectiveValues,
  ) ||
  normalizeEffectiveDirective("script-src-elem") !== "script-src-elem" ||
  normalizeEffectiveDirective("trusted-types") !== "unknown" ||
  normalizeEffectiveDirective("script_src") !== null ||
  CSP_REPORT_BLOCKED_TARGET_COLUMN !== "blocked_target" ||
  !sameOrderedValues(CSP_BLOCKED_TARGET_VALUES, expectedBlockedTargetValues) ||
  !sameOrderedValues(sqlBlockedTargetValues, expectedBlockedTargetValues) ||
  !cspReportApi.includes(
    "[CSP_REPORT_BLOCKED_TARGET_COLUMN]: classifyBlockedTarget(",
  ) ||
  !cspReportApi.includes(
    "const effectiveDirective = normalizeEffectiveDirective(",
  ) ||
  !cspReportApi.includes("effective_directive: effectiveDirective,") ||
  /\bblocked_target_classification\s*:/.test(cspReportApi)
) {
  fail("the CSP API and DB closed report contract differ");
}

const requiredMigrationFragments = [
  "-- CSP_REPORT_CONTRACT_UPGRADE_BEGIN",
  "drop constraint if exists csp_violation_reports_effective_directive_check",
  "drop constraint if exists csp_violation_reports_blocked_target_check",
  "set effective_directive = 'unknown'",
  "when blocked_target in (",
  "then 'scheme'",
  "add constraint csp_violation_reports_effective_directive_check",
  ") not valid;",
  "validate constraint csp_violation_reports_effective_directive_check",
  "add constraint csp_violation_reports_blocked_target_check",
  ") not valid;",
  "validate constraint csp_violation_reports_blocked_target_check",
  "-- CSP_REPORT_CONTRACT_UPGRADE_END",
];
const normalizedCspContractMigration = cspContractMigration.toLowerCase();
let previousMigrationFragmentIndex = -1;
for (const requiredMigrationFragment of requiredMigrationFragments) {
  const fragmentIndex = normalizedCspContractMigration.indexOf(
    requiredMigrationFragment.toLowerCase(),
    previousMigrationFragmentIndex + 1,
  );
  if (fragmentIndex === -1) {
    fail(`the CSP DB migration lacks: ${requiredMigrationFragment}`);
  }
  previousMigrationFragmentIndex = fragmentIndex;
}

for (const [directive, values] of Object.entries(policy.directives)) {
  if (
    !/^[a-z][a-z0-9-]*$/.test(directive) ||
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        /[\r\n;]/.test(value),
    )
  ) {
    fail(`directive ${directive} is invalid`);
  }
}

for (const [directive, forbiddenValues] of Object.entries(
  policy.forbiddenTokens ?? {},
)) {
  const actualValues = policy.directives[directive];
  if (!Array.isArray(actualValues)) {
    fail(`forbidden-token owner ${directive} has no directive`);
  }
  for (const forbiddenValue of forbiddenValues) {
    if (actualValues.includes(forbiddenValue)) {
      fail(`${directive} contains forbidden token ${forbiddenValue}`);
    }
  }
}

const expectedProviderConfig = renderVercelProjectConfig({
  config: vercelConfig,
  cspMode: "enforced",
  cspPolicy: policy,
});
if (JSON.stringify(expectedProviderConfig) !== JSON.stringify(vercelConfig)) {
  fail("vercel.json is not the rendered enforced CSP target");
}
const expectedHeaders = renderCspHeaders({
  cspMode: "enforced",
  cspPolicy: policy,
});
const globalHeaderRule = vercelConfig.headers?.find(
  (rule) => rule.source === "/(.*)",
);
if (!globalHeaderRule || !Array.isArray(globalHeaderRule.headers)) {
  fail("vercel.json has no global response-header rule");
}

const responseHeaders = new Map();
for (const header of globalHeaderRule.headers) {
  const normalizedName = header.key?.toLowerCase();
  if (
    typeof normalizedName !== "string" ||
    typeof header.value !== "string" ||
    responseHeaders.has(normalizedName)
  ) {
    fail("vercel.json contains an invalid or duplicate global header");
  }
  responseHeaders.set(normalizedName, header.value);
}

if (
  responseHeaders.get("content-security-policy") !==
    expectedHeaders["Content-Security-Policy"] ||
  responseHeaders.has("content-security-policy-report-only")
) {
  fail("the enforced provider CSP differs from config/csp-policy.json");
}

for (const [name, expectedValue] of Object.entries(
  policy.securityHeaders ?? {},
)) {
  if (responseHeaders.get(name.toLowerCase()) !== expectedValue) {
    fail(`provider security header ${name} differs from the policy`);
  }
}

for (const obsoleteHeader of [
  "strict-transport-security",
  "x-xss-protection",
]) {
  if (responseHeaders.has(obsoleteHeader)) {
    fail(`provider-owned or obsolete header is duplicated: ${obsoleteHeader}`);
  }
}

if (/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i.test(indexHtml)) {
  fail("index.html contains an inline script");
}
if (/<style\b/i.test(indexHtml) || /\sstyle\s*=/i.test(indexHtml)) {
  fail("index.html contains inline CSS");
}
if (
  !/<script\b[^>]*\bsrc=["']\/theme-prepaint\.js["'][^>]*>/i.test(indexHtml)
) {
  fail("the external theme prepaint script is missing");
}

await collectProductionSources(path.join(root, "src"));
const forbiddenRuntimeStylePatterns = [
  {
    label: "JSX style attribute",
    pattern: /<[A-Za-z][^>]*\bstyle\s*=/su,
  },
  {
    label: "DOM style property",
    pattern: /\.\s*style\s*(?:\.|\[|\?\.)/u,
  },
  {
    label: "style attribute mutation",
    pattern: /\b(?:setAttribute|removeAttribute)\s*\(\s*["']style["']/u,
  },
  {
    label: "CSSOM rule mutation",
    pattern:
      /\b(?:insertRule|deleteRule|replaceSync)\s*\(|\bCSSStyleDeclaration\b/u,
  },
  {
    label: "runtime stylesheet creation",
    pattern:
      /\bnew\s+CSSStyleSheet\s*\(|\bcreateElement\s*\(\s*["']style["']\s*\)|\badoptedStyleSheets\b/u,
  },
];
for (const sourcePath of productionSources.sort()) {
  const source = await readFile(sourcePath, "utf8");
  for (const { label, pattern } of forbiddenRuntimeStylePatterns) {
    if (pattern.test(source)) {
      fail(
        `${label} remains in ${path.relative(root, sourcePath).replaceAll("\\", "/")}`,
      );
    }
  }
}

console.log(
  `PASS CSP policy: ${Object.keys(policy.directives).length} directives and ${
    responseHeaders.size
  } provider headers match ${policy.policyId}; ${productionSources.length} production sources contain no inline runtime style mutation.`,
);
