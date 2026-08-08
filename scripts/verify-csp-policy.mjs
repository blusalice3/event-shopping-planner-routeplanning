import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonStrict } from "./lib/canonical-json.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const [policy, vercelConfig, indexHtml] = await Promise.all([
  readJsonStrict(path.join(root, "config", "csp-policy.json")),
  readJsonStrict(path.join(root, "vercel.json")),
  readFile(path.join(root, "index.html"), "utf8"),
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

const expectedCspHeader = Object.entries(policy.directives)
  .map(([directive, values]) => `${directive} ${values.join(" ")}`)
  .join("; ");
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
  responseHeaders.get("content-security-policy") !== expectedCspHeader ||
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
