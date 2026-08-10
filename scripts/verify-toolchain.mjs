#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";
import {
  canonicalize,
  fail,
  readJson,
  sha256,
  utf8Compare,
} from "./foundation-policy-utils.mjs";

const allowRuntimeMismatch = process.argv.includes("--allow-runtime-mismatch");
const packageJson = await readJson("package.json");
const lockfile = await readJson("package-lock.json");
const policy = await readJson("config/toolchain-versions.json");
const errors = [];
const warnings = [];
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const directPackages = {
  ...(packageJson.dependencies ?? {}),
  ...(packageJson.devDependencies ?? {}),
};
const lockRoot = lockfile.packages?.[""];

if (lockfile.lockfileVersion !== 3 || lockRoot === undefined) {
  errors.push(
    "package-lock.json must use lockfileVersion 3 with a root package",
  );
}

for (const [name, declaredVersion] of Object.entries(directPackages).sort(
  ([left], [right]) => utf8Compare(left, right),
)) {
  if (!exactVersion.test(declaredVersion)) {
    errors.push(`${name}: top-level version must be an exact semver`);
    continue;
  }
  const lockedVersion = lockfile.packages?.[`node_modules/${name}`]?.version;
  if (lockedVersion !== declaredVersion) {
    errors.push(
      `${name}: package.json ${declaredVersion} does not match lock ${lockedVersion ?? "missing"}`,
    );
  }
  const rootDeclared =
    lockRoot?.dependencies?.[name] ?? lockRoot?.devDependencies?.[name];
  if (rootDeclared !== declaredVersion) {
    errors.push(
      `${name}: lock root ${rootDeclared ?? "missing"} does not match package.json`,
    );
  }
}

for (const [name, expectedVersion] of Object.entries({
  ...policy.packages,
  ...policy.preservedPackages,
})) {
  if (directPackages[name] !== expectedVersion) {
    errors.push(
      `${name}: policy requires ${expectedVersion}, found ${directPackages[name] ?? "missing"}`,
    );
  }
}

if (packageJson.engines?.node !== policy.runtime.node) {
  errors.push("package.json engines.node does not match toolchain policy");
}
if (packageJson.engines?.npm !== policy.runtime.npm) {
  errors.push("package.json engines.npm does not match toolchain policy");
}
if (packageJson.packageManager !== `npm@${policy.runtime.npm}`) {
  errors.push("packageManager does not match the exact npm policy");
}

const versionsByPackage = new Map();
for (const [lockPath, metadata] of Object.entries(lockfile.packages ?? {})) {
  const marker = "node_modules/";
  const index = lockPath.lastIndexOf(marker);
  if (index < 0 || typeof metadata?.version !== "string") continue;
  const tail = lockPath.slice(index + marker.length);
  const segments = tail.split("/");
  const packageName = tail.startsWith("@")
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
  const versions = versionsByPackage.get(packageName) ?? new Set();
  versions.add(metadata.version);
  versionsByPackage.set(packageName, versions);
}

for (const name of policy.singleVersionPackages) {
  const versions = [...(versionsByPackage.get(name) ?? [])].sort(utf8Compare);
  if (versions.length !== 1) {
    errors.push(
      `${name}: expected one installed version, found ${versions.join(", ") || "none"}`,
    );
  }
}

const duplicateInventory = [...versionsByPackage]
  .filter(([, versions]) => versions.size > 1)
  .map(([name, versions]) => ({
    name,
    versions: [...versions].sort(utf8Compare),
  }))
  .sort((left, right) => utf8Compare(left.name, right.name));
if (
  duplicateInventory.length !== policy.duplicatePackageBaseline.packageCount
) {
  errors.push(
    `duplicate package count changed from ${policy.duplicatePackageBaseline.packageCount} to ${duplicateInventory.length}`,
  );
}
if (
  sha256(canonicalize(duplicateInventory)) !==
  policy.duplicatePackageBaseline.sha256
) {
  errors.push("duplicate package inventory hash differs from policy");
}

for (const [name, versions] of versionsByPackage) {
  if (!name.startsWith("workbox-")) continue;
  for (const version of versions) {
    if (version !== "7.4.1") {
      errors.push(`${name}: Workbox family must be 7.4.1, found ${version}`);
    }
  }
}

for (const exception of policy.temporaryExceptions) {
  if (directPackages[exception.package] !== exception.version) {
    errors.push(
      `${exception.id}: temporary package must remain exact at ${exception.version}`,
    );
  }
  if (Date.parse(`${exception.expiry}T00:00:00Z`) <= Date.now()) {
    errors.push(`${exception.id}: temporary exception is expired`);
  }
}

const scriptDependencies = new Map();
for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
  const dependencies = [
    ...command.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g),
  ].map((match) => match[1]);
  scriptDependencies.set(name, dependencies);
}

const visiting = new Set();
const visited = new Set();
const visitScript = (name, trail) => {
  if (visiting.has(name)) {
    errors.push(`script recursion detected: ${[...trail, name].join(" -> ")}`);
    return;
  }
  if (visited.has(name)) return;
  visiting.add(name);
  for (const dependency of scriptDependencies.get(name) ?? []) {
    if (!(dependency in packageJson.scripts)) {
      errors.push(`${name}: references missing npm script ${dependency}`);
    } else {
      visitScript(dependency, [...trail, name]);
    }
  }
  visiting.delete(name);
  visited.add(name);
};
for (const name of scriptDependencies.keys()) visitScript(name, []);

if (packageJson.scripts?.build !== "npm run build:release-a") {
  errors.push("build must be the one-way alias to build:release-a");
}
if (!packageJson.scripts?.["build:release-a"]?.includes("npm run build:app")) {
  errors.push("build:release-a must invoke build:app");
}
if (/\bnpm run build(?:\s|$)/.test(packageJson.scripts?.["build:release-a"])) {
  errors.push("build:release-a must not call build recursively");
}

const currentNode = process.versions.node;
let currentNpm = null;
const npmExecPath = process.env.npm_execpath;
if (typeof npmExecPath === "string" && npmExecPath.length > 0) {
  currentNpm = execFileSync(process.execPath, [npmExecPath, "--version"], {
    encoding: "utf8",
  }).trim();
} else {
  const userAgentMatch =
    process.env.npm_config_user_agent?.match(/\bnpm\/([^\s]+)/);
  if (userAgentMatch) {
    currentNpm = userAgentMatch[1];
  } else {
    if (process.platform === "win32") {
      currentNpm = execFileSync(
        process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
        ["/d", "/s", "/c", "npm --version"],
        { encoding: "utf8" },
      ).trim();
    } else {
      currentNpm = execFileSync("npm", ["--version"], {
        encoding: "utf8",
      }).trim();
    }
  }
}

for (const [name, current, expected] of [
  ["Node", currentNode, policy.runtime.node],
  ["npm", currentNpm, policy.runtime.npm],
]) {
  if (current === expected) continue;
  const message = `${name}: runtime ${current} does not match required ${expected}`;
  if (allowRuntimeMismatch) warnings.push(message);
  else errors.push(message);
}

if (errors.length > 0) {
  fail("FAIL toolchain verification", errors);
} else {
  process.stdout.write(
    `PASS toolchain policy: ${Object.keys(directPackages).length} exact top-level packages; Node ${currentNode}; npm ${currentNpm}\n`,
  );
  for (const warning of warnings) {
    process.stdout.write(`BLOCKED-RUNTIME ${warning}\n`);
  }
}
