import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveProviderEnvironmentContract } from "../lib/csp-delivery.mjs";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  readJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";

export const VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.vercel-provider-observation+json;version=1";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const API_ORIGIN = "https://api.vercel.com";
const UTF8_COMPARE = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const RUNTIME_LOG_RETENTION_DAYS = Object.freeze({
  hobby: 1 / 24,
  pro: 1,
  enterprise: 3,
});
const OBSERVATION_KEYS = Object.freeze([
  "schemaVersion",
  "evidenceKind",
  "provider",
  "observedAt",
  "providerTeamId",
  "providerProjectId",
  "productionEnvironmentName",
  "providerNodeFamily",
  "productionBranch",
  "autoAssignCustomProductionDomains",
  "gitProductionAutoDeploy",
  "gitPreviewAutoDeploy",
  "gitIntegration",
  "allowedPreviewBranches",
  "ownedProductionDomains",
  "presentEnvironmentNames",
  "rawRequestByteCeilings",
  "wafRules",
  "logPolicy",
  "logRetentionEvidence",
  "hstsOwner",
  "hstsPolicy",
  "hsts",
  "configurationEvidenceKinds",
  "evidenceReceipts",
]);
const RECEIPT_KEYS = Object.freeze([
  "kind",
  "method",
  "requestUrl",
  "status",
  "responseDate",
  "etag",
  "contentType",
  "strictTransportSecurity",
  "bodySha256",
  "responseSha256",
]);

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const assertExactKeys = (value, expected, label) => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort(UTF8_COMPARE);
  const sortedExpected = [...expected].sort(UTF8_COMPARE);
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} has an unexpected property set`);
  }
};

const requireString = (value, label) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

const assertToken = (token) => {
  const hasControlCharacter =
    typeof token === "string" &&
    Array.from(token).some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    });
  if (
    typeof token !== "string" ||
    token.length < 16 ||
    token.length > 4_096 ||
    hasControlCharacter
  ) {
    throw new Error("VERCEL_TOKEN is absent or invalid");
  }
  return token;
};

const sortedUniqueStrings = (values, label, allowEmpty = false) => {
  if (
    !Array.isArray(values) ||
    (!allowEmpty && values.length === 0) ||
    values.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    throw new Error(`${label} must contain non-empty strings`);
  }
  const sorted = [...new Set(values)].sort(UTF8_COMPARE);
  if (sorted.length !== values.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return sorted;
};

const requestUrl = (baseUrl, pathname, query = {}) => {
  const url = new URL(pathname, baseUrl);
  for (const [name, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) {
      url.searchParams.set(name, String(value));
    }
  }
  url.searchParams.sort();
  return url.href;
};

const observationUrls = (policy) => {
  const baseUrl = policy.observationPolicy.apiBaseUrl;
  const teamId = encodeURIComponent(policy.expectedTeamId);
  const projectId = encodeURIComponent(policy.expectedProjectId);
  const common = { teamId: policy.expectedTeamId };
  return {
    team: requestUrl(baseUrl, `/v2/teams/${teamId}`),
    project: requestUrl(baseUrl, `/v9/projects/${projectId}`, common),
    domains: requestUrl(baseUrl, `/v9/projects/${projectId}/domains`, {
      ...common,
      limit: 100,
      production: true,
    }),
    "environment-presence": requestUrl(
      baseUrl,
      `/v10/projects/${projectId}/env`,
      {
        ...common,
        decrypt: false,
      },
    ),
    waf: requestUrl(
      baseUrl,
      `/v1/security/firewall/config/${encodeURIComponent(
        policy.observationPolicy.firewallConfigVersion,
      )}`,
      {
        projectId: policy.expectedProjectId,
        teamId: policy.expectedTeamId,
      },
    ),
    "log-retention": requestUrl(baseUrl, "/v1/drains", {
      includeMetadata: true,
      projectId: policy.expectedProjectId,
      teamId: policy.expectedTeamId,
    }),
  };
};

export const assertProviderPolicyConfigured = (policy) => {
  if (
    !isRecord(policy) ||
    policy.schemaVersion !== 1 ||
    policy.bindingStatus !== "configured" ||
    policy.provider !== "vercel" ||
    !Array.isArray(policy.blockerCodes) ||
    policy.blockerCodes.length !== 0
  ) {
    throw new Error(
      `Provider policy is not configured: ${(policy?.blockerCodes ?? []).join(
        ", ",
      )}`,
    );
  }
  requireString(policy.expectedTeamId, "expectedTeamId");
  requireString(policy.expectedProjectId, "expectedProjectId");
  sortedUniqueStrings(policy.ownedProductionDomains, "ownedProductionDomains");
  sortedUniqueStrings(
    policy.requiredEnvironmentNames,
    "requiredEnvironmentNames",
  );
  sortedUniqueStrings(
    policy.cspReportEnvironmentNames,
    "cspReportEnvironmentNames",
    true,
  );
  sortedUniqueStrings(
    policy.forbiddenEnvironmentNames,
    "forbiddenEnvironmentNames",
    true,
  );
  for (const cspMode of ["none", "report-only", "enforced"]) {
    resolveProviderEnvironmentContract(policy, cspMode);
  }
  if (
    !isRecord(policy.wafRules) ||
    Object.values(policy.wafRules).some(
      (rule) => !isRecord(rule) || typeof rule.id !== "string",
    )
  ) {
    throw new Error("Provider WAF rules are not configured");
  }
  if (
    !isRecord(policy.logPolicy) ||
    typeof policy.logPolicy.retentionDays !== "number" ||
    policy.logPolicy.retentionDays <= 0 ||
    !isRecord(policy.logPolicy.retentionObservation) ||
    !["vercel-runtime-plan-v1", "vercel-drain-provider-field-v1"].includes(
      policy.logPolicy.retentionObservation.kind,
    )
  ) {
    throw new Error("Provider log retention is not configured");
  }
  if (
    !isRecord(policy.hstsPolicy) ||
    !Number.isSafeInteger(policy.hstsPolicy.minimumMaxAgeSeconds) ||
    policy.hstsPolicy.minimumMaxAgeSeconds <= 0 ||
    typeof policy.hstsPolicy.requireIncludeSubDomains !== "boolean" ||
    typeof policy.hstsPolicy.requirePreload !== "boolean"
  ) {
    throw new Error("Provider HSTS policy is not configured");
  }
  const observation = policy.observationPolicy;
  if (
    !isRecord(observation) ||
    observation.apiBaseUrl !== API_ORIGIN ||
    observation.firewallConfigVersion !== "active" ||
    !Number.isSafeInteger(observation.maxResponseAgeSeconds) ||
    observation.maxResponseAgeSeconds <= 0 ||
    !Number.isSafeInteger(observation.maxFutureClockSkewSeconds) ||
    observation.maxFutureClockSkewSeconds < 0 ||
    typeof observation.requireEtag !== "boolean"
  ) {
    throw new Error("Provider observation policy is invalid");
  }
  return policy;
};

const responseReceiptHash = (receipt) =>
  sha256Json({
    status: receipt.status,
    responseDate: receipt.responseDate,
    etag: receipt.etag,
    contentType: receipt.contentType,
    strictTransportSecurity: receipt.strictTransportSecurity,
    bodySha256: receipt.bodySha256,
  });

const assertFreshDate = (dateValue, policy, nowMilliseconds, label) => {
  const timestamp = Date.parse(dateValue);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} has no valid authoritative Date header`);
  }
  const ageMilliseconds = nowMilliseconds - timestamp;
  if (
    ageMilliseconds > policy.observationPolicy.maxResponseAgeSeconds * 1_000 ||
    ageMilliseconds <
      -policy.observationPolicy.maxFutureClockSkewSeconds * 1_000
  ) {
    throw new Error(`${label} is outside the provider freshness window`);
  }
};

const createFetcher = ({ policy, token, fetchImpl, nowMilliseconds }) => {
  const receipts = [];
  const fetchEvidence = async ({
    kind,
    url,
    method = "GET",
    authenticated = true,
    json = true,
  }) => {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        redirect: "error",
        cache: "no-store",
        headers: authenticated
          ? {
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
            }
          : {
              Accept: "*/*",
            },
      });
    } catch {
      throw new Error(`Provider observation request failed: ${url}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const responseDate = response.headers.get("date");
    if (responseDate === null) {
      throw new Error(`${kind} has no authoritative Date header`);
    }
    assertFreshDate(responseDate, policy, nowMilliseconds, kind);
    const etag = response.headers.get("etag");
    if (policy.observationPolicy.requireEtag && etag === null) {
      throw new Error(`${kind} has no required ETag header`);
    }
    const receiptBase = {
      kind,
      method,
      requestUrl: url,
      status: response.status,
      responseDate,
      etag,
      contentType: response.headers.get("content-type"),
      strictTransportSecurity: response.headers.get(
        "strict-transport-security",
      ),
      bodySha256: sha256Bytes(bytes),
    };
    const receipt = {
      ...receiptBase,
      responseSha256: responseReceiptHash(receiptBase),
    };
    receipts.push(receipt);
    if (!response.ok) {
      throw new Error(
        `Provider observation ${kind} returned ${response.status}`,
      );
    }
    if (!json) return { bytes, receipt };
    let value;
    try {
      value = parseJsonStrict(bytes.toString("utf8"), kind);
    } catch {
      throw new Error(`Provider observation ${kind} returned invalid JSON`);
    }
    return { value, receipt };
  };
  return { fetchEvidence, receipts };
};

const environmentEntries = (value) => {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.envs)) return value.envs;
  throw new Error("Vercel environment response has no env array");
};

const productionEnvironmentNames = (value) =>
  sortedUniqueStrings(
    environmentEntries(value)
      .filter((entry) => {
        if (!isRecord(entry)) return false;
        const targets = Array.isArray(entry.target)
          ? entry.target
          : entry.target === undefined
            ? []
            : [entry.target];
        return targets.includes("production") || entry.system === true;
      })
      .map((entry) => entry.key)
      .filter((key) => typeof key === "string" && key.length > 0),
    "observed production environment names",
    true,
  );

const projectDomains = (value, expectedProjectId) => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.domains) ||
    !isRecord(value.pagination) ||
    value.pagination.next !== null
  ) {
    throw new Error("Vercel domain response is absent or truncated");
  }
  const domains = value.domains.map((domain) => {
    if (
      !isRecord(domain) ||
      domain.projectId !== expectedProjectId ||
      domain.verified !== true
    ) {
      throw new Error("Vercel project domain is unverified or misbound");
    }
    return requireString(domain.name, "project domain");
  });
  return sortedUniqueStrings(domains, "observed production domains");
};

const targetGitDeploymentEnabled = (project, target) => {
  if (!isRecord(project.link)) return false;
  const rules = project.deploymentPolicy?.deploymentSources;
  if (!Array.isArray(rules)) return true;
  const matching = rules.filter(
    (rule) =>
      isRecord(rule) &&
      rule.enabled === true &&
      Array.isArray(rule.environments) &&
      rule.environments.some(
        (environment) =>
          environment?.type === "system" && environment.target === target,
      ),
  );
  if (matching.length === 0) return true;
  return matching.some(
    (rule) => Array.isArray(rule.sources) && rule.sources.includes("git"),
  );
};

const wafRuleProjection = (rule) => ({
  id: rule.id,
  active: rule.active === true,
  action: rule.action?.mitigate?.action ?? null,
  conditionGroup: rule.conditionGroup ?? [],
  rateLimit: rule.action?.mitigate?.rateLimit ?? null,
});

const observedWafRules = (firewall, expectedRules) => {
  if (
    !isRecord(firewall) ||
    firewall.firewallEnabled !== true ||
    !Array.isArray(firewall.rules)
  ) {
    throw new Error("Vercel active firewall configuration is unavailable");
  }
  return Object.fromEntries(
    Object.entries(expectedRules).map(([logicalName, expected]) => {
      const rule = firewall.rules.find(
        (candidate) => candidate?.id === expected.id,
      );
      return [logicalName, rule ? wafRuleProjection(rule) : null];
    }),
  );
};

const jsonPointerValue = (value, pointer) => {
  if (
    typeof pointer !== "string" ||
    !/^\/(?:[^/]|~[01])+(?:\/.*)?$/.test(pointer)
  ) {
    throw new Error("Log retention JSON pointer is invalid");
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, segment) => {
      if (
        (isRecord(current) || Array.isArray(current)) &&
        Object.hasOwn(current, segment)
      ) {
        return current[segment];
      }
      throw new Error("Log retention JSON pointer is absent");
    }, value);
};

const deriveLogRetention = ({ policy, team, drainsResponse }) => {
  const observation = policy.logPolicy.retentionObservation;
  const drains = Array.isArray(drainsResponse?.drains)
    ? drainsResponse.drains
    : null;
  if (drains === null) {
    throw new Error("Vercel Drains response has no drains array");
  }
  const activeLogDrainIds = drains
    .filter(
      (drain) =>
        isRecord(drain) &&
        drain.status === "enabled" &&
        isRecord(drain.schemas?.log),
    )
    .map((drain) => requireString(drain.id, "log drain id"))
    .sort(UTF8_COMPARE);
  let retentionDays;
  let source;
  if (observation.kind === "vercel-runtime-plan-v1") {
    if (observation.observabilityPlus !== false) {
      throw new Error(
        "Vercel API does not expose Observability Plus entitlement; retention is unprovable",
      );
    }
    const plan = team?.billing?.plan;
    retentionDays = RUNTIME_LOG_RETENTION_DAYS[plan];
    source = { kind: observation.kind, plan };
  } else {
    const drain = drains.find(
      (candidate) => candidate?.id === observation.drainId,
    );
    if (
      !isRecord(drain) ||
      drain.status !== "enabled" ||
      !isRecord(drain.schemas?.log)
    ) {
      throw new Error("Configured Vercel log drain is absent or disabled");
    }
    retentionDays = jsonPointerValue(drain, observation.jsonPointer);
    source = {
      kind: observation.kind,
      drainId: observation.drainId,
      jsonPointer: observation.jsonPointer,
    };
  }
  if (
    typeof retentionDays !== "number" ||
    !Number.isFinite(retentionDays) ||
    retentionDays <= 0
  ) {
    throw new Error("Vercel log retention observation is invalid");
  }
  return { retentionDays, source, activeLogDrainIds };
};

const parseHsts = (header, policy, domain) => {
  if (typeof header !== "string") {
    throw new Error(`HSTS header is absent for ${domain}`);
  }
  const directives = header
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  const maxAgeDirective = directives.find((value) => /^max-age=/i.test(value));
  const maxAgeSeconds = Number(maxAgeDirective?.split("=")[1]);
  const includeSubDomains = directives.some((value) =>
    /^includesubdomains$/i.test(value),
  );
  const preload = directives.some((value) => /^preload$/i.test(value));
  if (
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < policy.hstsPolicy.minimumMaxAgeSeconds ||
    (policy.hstsPolicy.requireIncludeSubDomains && !includeSubDomains) ||
    (policy.hstsPolicy.requirePreload && !preload)
  ) {
    throw new Error(`HSTS policy differs for ${domain}`);
  }
  return {
    domain,
    maxAgeSeconds,
    includeSubDomains,
    preload,
    headerSha256: createHash("sha256").update(header).digest("hex"),
  };
};

export const collectVercelProviderObservation = async ({
  policy,
  token,
  fetchImpl = globalThis.fetch,
  now = Date.now,
}) => {
  assertProviderPolicyConfigured(policy);
  assertToken(token);
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch implementation is unavailable");
  }
  const nowMilliseconds =
    typeof now === "function" ? Number(now()) : Number(now);
  if (!Number.isFinite(nowMilliseconds)) {
    throw new Error("Observation clock is invalid");
  }
  const urls = observationUrls(policy);
  const { fetchEvidence, receipts } = createFetcher({
    policy,
    token,
    fetchImpl,
    nowMilliseconds,
  });
  const [
    teamResult,
    projectResult,
    domainsResult,
    envResult,
    wafResult,
    drainsResult,
  ] = await Promise.all([
    fetchEvidence({ kind: "team", url: urls.team }),
    fetchEvidence({ kind: "project", url: urls.project }),
    fetchEvidence({ kind: "domains", url: urls.domains }),
    fetchEvidence({
      kind: "environment-presence",
      url: urls["environment-presence"],
    }),
    fetchEvidence({ kind: "waf", url: urls.waf }),
    fetchEvidence({ kind: "log-retention", url: urls["log-retention"] }),
  ]);
  const team = teamResult.value;
  const project = projectResult.value;
  if (
    !isRecord(team) ||
    team.id !== policy.expectedTeamId ||
    !isRecord(project) ||
    project.id !== policy.expectedProjectId ||
    project.accountId !== policy.expectedTeamId
  ) {
    throw new Error("Vercel team/project binding differs");
  }
  const ownedProductionDomains = projectDomains(
    domainsResult.value,
    policy.expectedProjectId,
  );
  const hsts = await Promise.all(
    ownedProductionDomains.map(async (domain) => {
      const result = await fetchEvidence({
        kind: `hsts:${domain}`,
        url: `https://${domain}/`,
        method: "HEAD",
        authenticated: false,
        json: false,
      });
      return parseHsts(result.receipt.strictTransportSecurity, policy, domain);
    }),
  );
  const gitProductionAutoDeploy = targetGitDeploymentEnabled(
    project,
    "production",
  );
  const gitPreviewAutoDeploy = targetGitDeploymentEnabled(project, "preview");
  if (policy.allowedPreviewBranches.length > 0) {
    throw new Error(
      "Vercel project API does not expose an exact preview branch allowlist",
    );
  }
  const logRetention = deriveLogRetention({
    policy,
    team,
    drainsResponse: drainsResult.value,
  });
  const observation = {
    schemaVersion: 1,
    evidenceKind: "vercel-provider-observation-v1",
    provider: "vercel",
    observedAt: new Date(nowMilliseconds).toISOString(),
    providerTeamId: team.id,
    providerProjectId: project.id,
    productionEnvironmentName: policy.productionEnvironmentName,
    providerNodeFamily: project.nodeVersion,
    productionBranch: project.link?.productionBranch ?? null,
    autoAssignCustomProductionDomains: project.autoAssignCustomDomains,
    gitProductionAutoDeploy,
    gitPreviewAutoDeploy,
    gitIntegration: {
      connected: isRecord(project.link),
      provider: project.link?.type ?? null,
      productionBranch: project.link?.productionBranch ?? null,
    },
    allowedPreviewBranches: gitPreviewAutoDeploy ? ["*"] : [],
    ownedProductionDomains,
    presentEnvironmentNames: productionEnvironmentNames(envResult.value),
    rawRequestByteCeilings: policy.rawRequestByteCeilings,
    wafRules: observedWafRules(wafResult.value, policy.wafRules),
    logPolicy: {
      ...policy.logPolicy,
      retentionDays: logRetention.retentionDays,
    },
    logRetentionEvidence: {
      ...logRetention.source,
      activeLogDrainIds: logRetention.activeLogDrainIds,
      retentionDays: logRetention.retentionDays,
    },
    hstsOwner: "provider",
    hstsPolicy: policy.hstsPolicy,
    hsts: hsts.sort((left, right) => UTF8_COMPARE(left.domain, right.domain)),
    configurationEvidenceKinds: [...policy.requiredConfigurationEvidence].sort(
      UTF8_COMPARE,
    ),
    evidenceReceipts: receipts.sort((left, right) =>
      UTF8_COMPARE(left.kind, right.kind),
    ),
  };
  if (canonicalJsonBytes(observation).includes(Buffer.from(token, "utf8"))) {
    throw new Error("Provider observation attempted to expose a credential");
  }
  assertVercelObservationEvidence(observation, policy, nowMilliseconds);
  return observation;
};

export const assertVercelObservationEvidence = (
  observation,
  policy,
  now = Date.now(),
) => {
  assertProviderPolicyConfigured(policy);
  if (
    !isRecord(observation) ||
    observation.schemaVersion !== 1 ||
    observation.evidenceKind !== "vercel-provider-observation-v1" ||
    observation.provider !== "vercel" ||
    !Array.isArray(observation.evidenceReceipts)
  ) {
    throw new Error("Vercel provider observation evidence is invalid");
  }
  assertExactKeys(
    observation,
    OBSERVATION_KEYS,
    "Vercel provider observation evidence",
  );
  const nowMilliseconds =
    typeof now === "function" ? Number(now()) : Number(now);
  assertFreshDate(
    observation.observedAt,
    policy,
    nowMilliseconds,
    "provider observation",
  );
  const expectedUrls = observationUrls(policy);
  const expectedReceiptUrls = new Map([
    ...Object.entries(expectedUrls),
    ...policy.ownedProductionDomains.map((domain) => [
      `hsts:${domain}`,
      `https://${domain}/`,
    ]),
  ]);
  if (
    observation.evidenceReceipts.length !== expectedReceiptUrls.size ||
    new Set(observation.evidenceReceipts.map((receipt) => receipt.kind))
      .size !== expectedReceiptUrls.size
  ) {
    throw new Error("Vercel provider receipt set is incomplete");
  }
  for (const receipt of observation.evidenceReceipts) {
    assertExactKeys(receipt, RECEIPT_KEYS, "Vercel provider receipt");
    if (
      !isRecord(receipt) ||
      receipt.requestUrl !== expectedReceiptUrls.get(receipt.kind) ||
      receipt.status < 200 ||
      receipt.status >= 400 ||
      !SHA256_PATTERN.test(receipt.bodySha256) ||
      !SHA256_PATTERN.test(receipt.responseSha256) ||
      receipt.responseSha256 !== responseReceiptHash(receipt) ||
      (policy.observationPolicy.requireEtag && typeof receipt.etag !== "string")
    ) {
      throw new Error(`Vercel provider receipt is invalid: ${receipt?.kind}`);
    }
    assertFreshDate(
      receipt.responseDate,
      policy,
      nowMilliseconds,
      `receipt ${receipt.kind}`,
    );
  }
  return observation;
};

export const parseCollectorCliArguments = (arguments_) => {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (name !== "--output" && name !== "--policy") {
      throw new Error(`Unknown collector argument: ${name}`);
    }
    if (values.has(name)) {
      throw new Error(`Duplicate collector argument: ${name}`);
    }
    const value = arguments_[index + 1];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error(`${name} requires exactly one value`);
    }
    values.set(name, value);
    index += 1;
  }
  if (!values.has("--output")) {
    throw new Error("--output requires a new evidence file path");
  }
  return {
    outputPath: values.get("--output"),
    policyPath: values.get("--policy") ?? null,
  };
};

export const resolveCollectorPaths = (
  arguments_,
  workingDirectory = process.cwd(),
) => {
  const parsed = parseCollectorCliArguments(arguments_);
  const outputPath = path.resolve(workingDirectory, parsed.outputPath);
  const policyPath = path.resolve(
    workingDirectory,
    parsed.policyPath ?? path.join(root, "config", "provider-policy.json"),
  );
  const comparable = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  if (comparable(outputPath) === comparable(policyPath)) {
    throw new Error("Provider observation output must differ from policy path");
  }
  return { outputPath, policyPath };
};

export const writeProviderObservationFile = async (outputPath, observation) => {
  const bytes = canonicalJsonBytes(observation);
  await writeFile(outputPath, bytes, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return { bytes, sha256: sha256Bytes(bytes) };
};

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { outputPath, policyPath } = resolveCollectorPaths(
    process.argv.slice(2),
  );
  const policy = await readJsonStrict(policyPath);
  const observation = await collectVercelProviderObservation({
    policy,
    token: process.env.VERCEL_TOKEN,
  });
  const written = await writeProviderObservationFile(outputPath, observation);
  process.stdout.write(
    `PASS wrote Vercel provider observation ${written.sha256}\n`,
  );
}
