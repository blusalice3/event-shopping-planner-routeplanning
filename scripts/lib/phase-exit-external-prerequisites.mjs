import { readFile } from "node:fs/promises";
import { win32 as windowsPath } from "node:path";
import { parseJsonStrict, sha256Json } from "./canonical-json.mjs";

export const FORMAL_EXTERNAL_PREREQUISITE_AUTHORITIES = Object.freeze([
  "backup-restore-rehearsal",
  "idb-device-compatibility",
  "pwa-multiclient-drill",
]);

export const BACKUP_CREDENTIAL_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "FOUNDATION_BACKUP_API_TOKEN",
  "FOUNDATION_BACKUP_RESTORE_DATABASE_CA_PEM",
  "FOUNDATION_BACKUP_RESTORE_DATABASE_URL",
  "FOUNDATION_BACKUP_SOURCE_DATABASE_CA_PEM",
  "FOUNDATION_BACKUP_SOURCE_DATABASE_URL",
]);

export const MANAGED_DEVICE_RUNNER_LABELS = Object.freeze([
  "Windows",
  "X64",
  "foundation-device",
  "managed",
  "self-hosted",
]);

const ROOT_KEYS = Object.freeze([
  "schemaVersion",
  "formalAuthorities",
  "activationStatus",
  "blockerCodes",
  "backupRestore",
  "managedDeviceExecution",
]);
const BACKUP_KEYS = Object.freeze([
  "bindingStatus",
  "provider",
  "apiOrigin",
  "sourceProjectRef",
  "restoreTarget",
  "recoveryPointObjectiveSeconds",
  "recoveryTimeObjectiveSeconds",
  "owner",
  "credentialEnvironmentAllowlist",
]);
const RESTORE_TARGET_KEYS = Object.freeze([
  "environment",
  "projectRef",
  "namespacePrefix",
]);
const DEVICE_KEYS = Object.freeze([
  "bindingStatus",
  "runnerGroup",
  "requiredLabels",
  "operatingSystem",
  "browser",
  "deviceProfiles",
  "attestation",
  "installedPwaLaunchAuthority",
]);
const OPERATING_SYSTEM_KEYS = Object.freeze([
  "family",
  "release",
  "architecture",
]);
const BROWSER_KEYS = Object.freeze([
  "family",
  "binaryPath",
  "exactVersion",
  "managedEnrollmentIdSha256",
]);
const DEVICE_PROFILE_KEYS = Object.freeze([
  "id",
  "clientKind",
  "installedMode",
  "profileName",
  "profilePath",
  "profileRoot",
]);
const ATTESTATION_KEYS = Object.freeze([
  "algorithm",
  "publicKeyFingerprintSha256",
]);
const PWA_LAUNCH_KEYS = Object.freeze([
  "bindingStatus",
  "kind",
  "forceInstallPolicyName",
  "forceInstallPolicyValueSha256",
  "installUrl",
  "applicationId",
  "requiredPolicyStatus",
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;
const NAMESPACE_PREFIX_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,40}[a-z0-9])$/u;
const OWNER_PATTERN =
  /^github-team:[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const OPAQUE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])$/u;
const BROWSER_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){3}$/u;
const CHROMIUM_APPLICATION_ID_PATTERN = /^[a-p]{32}$/u;
const PRODUCTION_TARGET_PATTERN = /(?:^|[-_.])(prod|production)(?:$|[-_.])/iu;
const PLACEHOLDER_PATTERN =
  /(?:^|[^a-z0-9])(change[-_ ]?me|dummy|example|placeholder|sample|tbd|todo|unknown|unset|xxx)(?:$|[^a-z0-9])/iu;

const isRecord = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const sameOrderedValues = (actual, expected) =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  actual.every((value, index) => value === expected[index]);

const assertExactKeys = (value, expected, label) => {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (!sameOrderedValues(actual, sortedExpected)) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
};

const assertNoPlaceholder = (value, label) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (PLACEHOLDER_PATTERN.test(value)) {
    throw new Error(`${label} contains a placeholder value`);
  }
};

const assertOptionalString = (value, label, assertion) => {
  if (value === null) return;
  assertNoPlaceholder(value, label);
  assertion(value, label);
};

const assertExactDistinctArray = (value, expected, label) => {
  if (!sameOrderedValues(value, expected)) {
    throw new Error(`${label} must be the exact ordered allowlist`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} contains duplicate values`);
  }
};

const assertBindingStatus = (actual, configured, label) => {
  const expected = configured ? "configured" : "unconfigured";
  if (actual !== expected) {
    throw new Error(`${label} status must be derived as ${expected}`);
  }
};

const assertHttpsOrigin = (value, label) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an HTTPS origin`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== value ||
    parsed.hostname === "localhost" ||
    parsed.hostname.endsWith(".local") ||
    PLACEHOLDER_PATTERN.test(parsed.hostname)
  ) {
    throw new Error(`${label} must be a non-placeholder HTTPS origin`);
  }
};

const assertHttpsUrl = (value, label) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    parsed.hostname === "localhost" ||
    parsed.hostname.endsWith(".local") ||
    PLACEHOLDER_PATTERN.test(parsed.hostname)
  ) {
    throw new Error(`${label} must be a non-placeholder HTTPS URL`);
  }
};

const assertProjectRef = (value, label) => {
  if (!PROJECT_REF_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact provider project reference`);
  }
};

const assertPositiveObjective = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400) {
    throw new Error(`${label} must be an integer from 1 through 86400 seconds`);
  }
};

const assertWindowsExecutable = (value, label) => {
  if (
    !/^[A-Za-z]:\\/u.test(value) ||
    !windowsPath.isAbsolute(value) ||
    windowsPath.extname(value).toLowerCase() !== ".exe" ||
    value.split(/[\\/]/u).includes("..") ||
    /[%$<>|?*]/u.test(value) ||
    [...value].some((character) => character.codePointAt(0) < 0x20)
  ) {
    throw new Error(`${label} must be an absolute literal Windows executable`);
  }
};

const assertWindowsDirectory = (value, label) => {
  if (
    !/^[A-Za-z]:\\/u.test(value) ||
    !windowsPath.isAbsolute(value) ||
    windowsPath.normalize(value) !== value ||
    windowsPath.extname(value) !== "" ||
    value.split(/[\\/]/u).includes("..") ||
    /[%$<>|?*]/u.test(value) ||
    [...value].some((character) => character.codePointAt(0) < 0x20)
  ) {
    throw new Error(`${label} must be an absolute literal Windows directory`);
  }
};

const assertNoDuplicateJsonMembers = (text, source) => {
  let index = 0;
  const fail = (message) => {
    throw new SyntaxError(`${source}: ${message} at byte ${index}`);
  };
  const skipWhitespace = () => {
    while (/\s/u.test(text[index] ?? "")) index += 1;
  };
  const scanString = () => {
    const start = index;
    if (text[index] !== '"') fail("expected JSON string");
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (character === "\\") {
        index += 1;
        const escaped = text[index];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(index + 1, index + 5))) {
            fail("invalid JSON unicode escape");
          }
          index += 5;
          continue;
        }
        if (!/["\\/bfnrt]/u.test(escaped ?? "")) {
          fail("invalid JSON escape");
        }
        index += 1;
        continue;
      }
      if (character.codePointAt(0) < 0x20) {
        fail("unescaped JSON control character");
      }
      index += 1;
    }
    fail("unterminated JSON string");
  };
  const scanNumber = () => {
    const match = text
      .slice(index)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (match === null) fail("invalid JSON number");
    index += match[0].length;
  };
  const scanLiteral = (literal) => {
    if (!text.startsWith(literal, index)) fail(`invalid JSON token`);
    index += literal.length;
  };
  const scanValue = () => {
    skipWhitespace();
    const character = text[index];
    if (character === "{") {
      scanObject();
    } else if (character === "[") {
      scanArray();
    } else if (character === '"') {
      scanString();
    } else if (character === "t") {
      scanLiteral("true");
    } else if (character === "f") {
      scanLiteral("false");
    } else if (character === "n") {
      scanLiteral("null");
    } else if (character === "-" || /[0-9]/u.test(character ?? "")) {
      scanNumber();
    } else {
      fail("expected JSON value");
    }
  };
  const scanObject = () => {
    index += 1;
    skipWhitespace();
    const keys = new Set();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    while (index < text.length) {
      skipWhitespace();
      const key = scanString();
      if (keys.has(key)) {
        throw new SyntaxError(`${source}: duplicate JSON member ${key}`);
      }
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ":") fail("expected colon after JSON member");
      index += 1;
      scanValue();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      if (text[index] !== ",") fail("expected comma between JSON members");
      index += 1;
    }
    fail("unterminated JSON object");
  };
  const scanArray = () => {
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    while (index < text.length) {
      scanValue();
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      if (text[index] !== ",") fail("expected comma between JSON values");
      index += 1;
    }
    fail("unterminated JSON array");
  };

  if (text.codePointAt(0) === 0xfeff) {
    throw new SyntaxError(`${source} must not contain a BOM`);
  }
  scanValue();
  skipWhitespace();
  if (index !== text.length) fail("unexpected data after JSON document");
};

export const parseExternalPrerequisitePolicy = (
  text,
  source = "External prerequisite policy",
) => {
  if (typeof text !== "string") {
    throw new TypeError(`${source} must be UTF-8 JSON text`);
  }
  assertNoDuplicateJsonMembers(text, source);
  return parseJsonStrict(text, source);
};

const validateBackupPolicy = (policy) => {
  assertExactKeys(policy, BACKUP_KEYS, "Backup/restore prerequisite");
  assertExactKeys(
    policy.restoreTarget,
    RESTORE_TARGET_KEYS,
    "Backup restore target",
  );
  if (policy.provider !== null && policy.provider !== "supabase") {
    throw new Error("Backup provider is unknown");
  }
  assertOptionalString(
    policy.apiOrigin,
    "Backup API origin",
    assertHttpsOrigin,
  );
  if (policy.provider === "supabase" && policy.apiOrigin !== null) {
    if (policy.apiOrigin !== "https://api.supabase.com") {
      throw new Error("Supabase backup API origin is invalid");
    }
  }
  assertOptionalString(
    policy.sourceProjectRef,
    "Backup source project",
    assertProjectRef,
  );
  if (policy.restoreTarget.environment !== "nonproduction") {
    throw new Error("Backup restore target must be explicitly nonproduction");
  }
  assertOptionalString(
    policy.restoreTarget.projectRef,
    "Backup restore target project",
    assertProjectRef,
  );
  assertNoPlaceholder(
    policy.restoreTarget.namespacePrefix,
    "Backup restore namespace prefix",
  );
  if (
    !NAMESPACE_PREFIX_PATTERN.test(policy.restoreTarget.namespacePrefix) ||
    PRODUCTION_TARGET_PATTERN.test(policy.restoreTarget.namespacePrefix)
  ) {
    throw new Error(
      "Backup restore namespace prefix is not nonproduction-safe",
    );
  }
  if (
    policy.restoreTarget.projectRef !== null &&
    (policy.restoreTarget.projectRef === policy.sourceProjectRef ||
      PRODUCTION_TARGET_PATTERN.test(policy.restoreTarget.projectRef))
  ) {
    throw new Error("Backup restore target resolves to production");
  }
  assertPositiveObjective(
    policy.recoveryPointObjectiveSeconds,
    "Backup recovery point objective",
  );
  assertPositiveObjective(
    policy.recoveryTimeObjectiveSeconds,
    "Backup recovery time objective",
  );
  assertOptionalString(policy.owner, "Backup owner", (value, label) => {
    if (!OWNER_PATTERN.test(value)) {
      throw new Error(`${label} must be a GitHub team authority`);
    }
  });
  assertExactDistinctArray(
    policy.credentialEnvironmentAllowlist,
    BACKUP_CREDENTIAL_ENVIRONMENT_ALLOWLIST,
    "Backup credential environment allowlist",
  );

  const blockerCodes = [];
  if (policy.provider === null)
    blockerCodes.push("backup-provider-unconfigured");
  if (policy.apiOrigin === null)
    blockerCodes.push("backup-api-origin-unconfigured");
  if (policy.sourceProjectRef === null)
    blockerCodes.push("backup-source-project-unconfigured");
  if (policy.restoreTarget.projectRef === null)
    blockerCodes.push("backup-restore-target-unconfigured");
  if (policy.owner === null) blockerCodes.push("backup-owner-unconfigured");
  blockerCodes.sort();
  assertBindingStatus(
    policy.bindingStatus,
    blockerCodes.length === 0,
    "Backup/restore prerequisite",
  );
  return blockerCodes;
};

const validateDeviceProfiles = (profiles) => {
  if (!Array.isArray(profiles) || profiles.length !== 2) {
    throw new Error(
      "Managed device profiles must contain exactly two profiles",
    );
  }
  const expected = [
    {
      id: "browser-tab",
      clientKind: "browser-tab",
      installedMode: false,
      profileName: "foundation-browser-tab",
    },
    {
      id: "installed-pwa",
      clientKind: "installed-pwa",
      installedMode: true,
      profileName: "foundation-installed-pwa",
    },
  ];
  const ids = new Set();
  const configuredRoots = new Set();
  let configured = true;
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    assertExactKeys(
      profile,
      DEVICE_PROFILE_KEYS,
      `Managed device profile ${index}`,
    );
    assertNoPlaceholder(
      profile.profileName,
      `Managed device profile ${index} name`,
    );
    if (ids.has(profile.id)) {
      throw new Error("Managed device profiles contain duplicate IDs");
    }
    ids.add(profile.id);
    for (const key of ["id", "clientKind", "installedMode", "profileName"]) {
      if (profile[key] !== expected[index][key]) {
        throw new Error(
          "Managed device profiles differ from the formal drills",
        );
      }
    }
    assertOptionalString(
      profile.profileRoot,
      `Managed device profile ${index} root`,
      assertWindowsDirectory,
    );
    assertOptionalString(
      profile.profilePath,
      `Managed device profile ${index} path`,
      assertWindowsDirectory,
    );
    if (
      (profile.profileRoot === null) !== (profile.profilePath === null) ||
      (profile.profileRoot !== null &&
        windowsPath.join(profile.profileRoot, profile.profileName) !==
          profile.profilePath)
    ) {
      throw new Error("Managed device profile root/path authority differs");
    }
    if (profile.profileRoot === null) {
      configured = false;
    } else {
      const comparableRoot = profile.profileRoot.toLowerCase();
      if (configuredRoots.has(comparableRoot)) {
        throw new Error("Managed device profile roots must be distinct");
      }
      configuredRoots.add(comparableRoot);
    }
  }
  return configured;
};

const validatePwaLaunchAuthority = (authority) => {
  assertExactKeys(authority, PWA_LAUNCH_KEYS, "Installed PWA launch authority");
  if (
    authority.kind !== "managed-os-pwa" ||
    authority.forceInstallPolicyName !== "WebAppInstallForceList" ||
    authority.requiredPolicyStatus !== "OK"
  ) {
    throw new Error("Installed PWA launch policy contract is invalid");
  }
  assertOptionalString(
    authority.forceInstallPolicyValueSha256,
    "Installed PWA force-install policy hash",
    (value, label) => {
      if (!SHA256_PATTERN.test(value)) throw new Error(`${label} is invalid`);
    },
  );
  assertOptionalString(
    authority.installUrl,
    "Installed PWA install URL",
    assertHttpsUrl,
  );
  assertOptionalString(
    authority.applicationId,
    "Installed PWA application ID",
    (value, label) => {
      if (!CHROMIUM_APPLICATION_ID_PATTERN.test(value)) {
        throw new Error(`${label} is invalid`);
      }
    },
  );
  const configured =
    authority.forceInstallPolicyValueSha256 !== null &&
    authority.installUrl !== null &&
    authority.applicationId !== null;
  assertBindingStatus(
    authority.bindingStatus,
    configured,
    "Installed PWA launch authority",
  );
  return configured;
};

const validateManagedDevicePolicy = (policy) => {
  assertExactKeys(policy, DEVICE_KEYS, "Managed device prerequisite");
  assertOptionalString(
    policy.runnerGroup,
    "Managed device runner group",
    (value, label) => {
      if (!OPAQUE_ID_PATTERN.test(value))
        throw new Error(`${label} is invalid`);
    },
  );
  assertExactDistinctArray(
    policy.requiredLabels,
    MANAGED_DEVICE_RUNNER_LABELS,
    "Managed device runner labels",
  );
  assertExactKeys(
    policy.operatingSystem,
    OPERATING_SYSTEM_KEYS,
    "Managed device operating system",
  );
  if (
    policy.operatingSystem.family !== "windows" ||
    policy.operatingSystem.release !== "11" ||
    policy.operatingSystem.architecture !== "x64"
  ) {
    throw new Error("Managed device operating system must be Windows 11 x64");
  }
  assertExactKeys(policy.browser, BROWSER_KEYS, "Managed device browser");
  if (policy.browser.family !== "chromium") {
    throw new Error("Managed device browser family is unknown");
  }
  assertOptionalString(
    policy.browser.binaryPath,
    "Managed device browser binary",
    assertWindowsExecutable,
  );
  assertOptionalString(
    policy.browser.exactVersion,
    "Managed device browser version",
    (value, label) => {
      if (!BROWSER_VERSION_PATTERN.test(value)) {
        throw new Error(`${label} must be an exact four-part version`);
      }
    },
  );
  assertOptionalString(
    policy.browser.managedEnrollmentIdSha256,
    "Managed browser enrollment hash",
    (value, label) => {
      if (!SHA256_PATTERN.test(value)) throw new Error(`${label} is invalid`);
    },
  );
  const profilesConfigured = validateDeviceProfiles(policy.deviceProfiles);
  assertExactKeys(
    policy.attestation,
    ATTESTATION_KEYS,
    "Managed device attestation",
  );
  if (policy.attestation.algorithm !== "ed25519") {
    throw new Error("Managed device attestation algorithm is unknown");
  }
  assertOptionalString(
    policy.attestation.publicKeyFingerprintSha256,
    "Managed device attestation public-key fingerprint",
    (value, label) => {
      if (!SHA256_PATTERN.test(value)) throw new Error(`${label} is invalid`);
    },
  );
  const pwaLaunchConfigured = validatePwaLaunchAuthority(
    policy.installedPwaLaunchAuthority,
  );

  const blockerCodes = [];
  if (policy.runnerGroup === null)
    blockerCodes.push("device-runner-group-unconfigured");
  if (policy.browser.binaryPath === null)
    blockerCodes.push("device-browser-binary-unconfigured");
  if (policy.browser.exactVersion === null)
    blockerCodes.push("device-browser-version-unconfigured");
  if (policy.browser.managedEnrollmentIdSha256 === null)
    blockerCodes.push("device-browser-enrollment-hash-unconfigured");
  if (policy.attestation.publicKeyFingerprintSha256 === null)
    blockerCodes.push("device-attestation-key-unconfigured");
  if (!profilesConfigured)
    blockerCodes.push("device-profile-authority-unconfigured");
  if (!pwaLaunchConfigured)
    blockerCodes.push("installed-pwa-launch-authority-unconfigured");
  blockerCodes.sort();
  assertBindingStatus(
    policy.bindingStatus,
    blockerCodes.length === 0,
    "Managed device prerequisite",
  );
  return blockerCodes;
};

export const verifyExternalPrerequisitePolicy = (policy) => {
  assertExactKeys(policy, ROOT_KEYS, "External prerequisite policy");
  if (policy.schemaVersion !== 1) {
    throw new Error(
      "External prerequisite policy schema version is unsupported",
    );
  }
  assertExactDistinctArray(
    policy.formalAuthorities,
    FORMAL_EXTERNAL_PREREQUISITE_AUTHORITIES,
    "Formal external prerequisite authorities",
  );
  const blockerCodes = [
    ...validateBackupPolicy(policy.backupRestore),
    ...validateManagedDevicePolicy(policy.managedDeviceExecution),
  ].sort();
  assertExactDistinctArray(
    policy.blockerCodes,
    blockerCodes,
    "External prerequisite blocker codes",
  );
  assertBindingStatus(
    policy.activationStatus,
    blockerCodes.length === 0,
    "External prerequisite policy",
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: "phase-exit-external-prerequisite-policy-report/v1",
    policySha256: sha256Json(policy),
    activationStatus: policy.activationStatus,
    blockerCodes: Object.freeze([...blockerCodes]),
    formalAuthorities: FORMAL_EXTERNAL_PREREQUISITE_AUTHORITIES,
  });
};

export const readAndVerifyExternalPrerequisitePolicy = async (policyPath) => {
  const text = await readFile(policyPath, "utf8");
  const policy = parseExternalPrerequisitePolicy(text, policyPath);
  return {
    policy,
    report: verifyExternalPrerequisitePolicy(policy),
    text,
  };
};
