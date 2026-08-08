#!/usr/bin/env node

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, "..");
const rootArgumentIndex = process.argv.indexOf("--root");
if (
  rootArgumentIndex >= 0 &&
  (process.argv[rootArgumentIndex + 1] === undefined ||
    process.argv[rootArgumentIndex + 1].startsWith("--"))
) {
  throw new Error("--root requires a path");
}
const root = path.resolve(
  rootArgumentIndex >= 0 ? process.argv[rootArgumentIndex + 1] : defaultRoot,
);
const policyPath = path.join(root, "config", "direct-dependency-usage.json");
const errors = [];
const sourceCache = new Map();
const specifierCache = new Map();
const manifestCache = new Map();
const compilerFileCache = new Map();

const normalizePath = (value) => value.replaceAll("\\", "/");
const relativePath = (value) => normalizePath(path.relative(root, value));
const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const sorted = (values) => [...values].sort(compareUtf8);
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const fail = (message) => {
  process.stderr.write(`FAIL direct dependency usage\n${message}\n`);
  process.exitCode = 1;
};

const readText = async (absolutePath) => {
  const normalized = path.resolve(absolutePath);
  if (!sourceCache.has(normalized)) {
    sourceCache.set(normalized, await readFile(normalized, "utf8"));
  }
  return sourceCache.get(normalized);
};

const readJson = async (absolutePath, label) => {
  let parsed;
  try {
    parsed = JSON.parse(await readText(absolutePath));
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parsed;
};

const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const assertKeys = (value, allowedKeys, label) => {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  const unknown = Object.keys(value).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unknown.length > 0) {
    errors.push(`${label} has unknown keys: ${sorted(unknown).join(", ")}`);
    return false;
  }
  return true;
};

const assertExactKeys = (value, expectedKeys, label) => {
  if (!assertKeys(value, expectedKeys, label)) return false;
  const missing = expectedKeys.filter(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  );
  if (missing.length > 0) {
    errors.push(`${label} is missing keys: ${missing.join(", ")}`);
    return false;
  }
  return true;
};

const packageNameFromSpecifier = (specifier) => {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:") ||
    /^[A-Za-z]+:/.test(specifier)
  ) {
    return null;
  }
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.length >= 2
      ? `${segments[0]}/${segments[1]}`
      : null
    : segments[0];
};

const extractSpecifiers = (source) => {
  const specifiers = new Set();
  const patterns = [
    /\b(?:from|import|require(?:\.resolve)?)\s*(?:\(\s*)?["']([^"'`]+)["']/g,
    /^\s*import\s+["']([^"'`]+)["']/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }
  return specifiers;
};

const extractImportMetaUrls = (source) => {
  const specifiers = new Set();
  const pattern =
    /\bnew\s+URL\s*\(\s*["']([^"'`]+)["']\s*,\s*import\.meta\.url\s*\)/g;
  for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  return specifiers;
};

const sourceSpecifiers = async (absolutePath) => {
  const normalized = path.resolve(absolutePath);
  if (!specifierCache.has(normalized)) {
    const source = await readText(normalized);
    specifierCache.set(normalized, {
      imports: extractSpecifiers(source),
      importMetaUrls: extractImportMetaUrls(source),
    });
  }
  return specifierCache.get(normalized);
};

const resolutionExtensions = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".d.ts",
  ".d.mts",
];

const isFile = async (candidate) => {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
};

const resolveLocalSpecifier = async (importer, specifier) => {
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
  const base = path.resolve(path.dirname(importer), cleanSpecifier);
  const candidates = [
    ...resolutionExtensions.map((extension) => `${base}${extension}`),
    ...resolutionExtensions
      .filter((extension) => extension !== "")
      .map((extension) => path.join(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return path.resolve(candidate);
  }
  return null;
};

const collectGraph = async (name, rootFiles) => {
  const reachable = new Set();
  const queue = [];
  for (const file of rootFiles) {
    const absolutePath = path.resolve(root, file);
    if (!(await isFile(absolutePath))) {
      errors.push(`${name}: graph root is missing: ${file}`);
    } else {
      queue.push(absolutePath);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift();
    if (reachable.has(current)) continue;
    reachable.add(current);
    const { imports, importMetaUrls } = await sourceSpecifiers(current);
    for (const specifier of new Set([...imports, ...importMetaUrls])) {
      if (!specifier.startsWith(".")) continue;
      const resolved = await resolveLocalSpecifier(current, specifier);
      if (resolved === null) {
        errors.push(
          `${name}: ${relativePath(current)} has unresolved local dependency ${specifier}`,
        );
      } else if (!reachable.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return reachable;
};

const walkFiles = async (directory) => {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries.sort((left, right) =>
    compareUtf8(left.name, right.name),
  )) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(absolutePath)));
    else if (entry.isFile()) files.push(absolutePath);
  }
  return files;
};

const scriptEntrypoints = (packageJson) => {
  const entries = new Set();
  const fileToken = /(?:^|\s)([A-Za-z0-9_./\\-]+\.(?:mjs|cjs|js))(?=\s|$)/g;
  for (const command of Object.values(packageJson.scripts ?? {})) {
    for (const match of command.matchAll(fileToken)) {
      const candidate = path.resolve(root, match[1]);
      if (normalizePath(candidate).startsWith(`${normalizePath(root)}/`)) {
        entries.add(relativePath(candidate));
      }
    }
  }
  return sorted(entries);
};

const directPackageManifest = async (packageName) => {
  if (!manifestCache.has(packageName)) {
    const manifestPath = path.join(
      root,
      "node_modules",
      ...packageName.split("/"),
      "package.json",
    );
    manifestCache.set(packageName, {
      path: manifestPath,
      json: await readJson(
        manifestPath,
        `node_modules/${packageName}/package.json`,
      ),
    });
  }
  return manifestCache.get(packageName);
};

const compilerFiles = (compilerConfig) => {
  if (!compilerFileCache.has(compilerConfig)) {
    const tscEntry = path.join(
      root,
      "node_modules",
      "typescript",
      "bin",
      "tsc",
    );
    const result = spawnSync(
      process.execPath,
      [tscEntry, "-p", compilerConfig, "--listFilesOnly", "--pretty", "false"],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `TypeScript could not resolve ${compilerConfig}: ${result.stderr.trim()}`,
      );
    }
    compilerFileCache.set(
      compilerConfig,
      new Set(
        result.stdout
          .split(/\r?\n/)
          .filter((line) => line.length > 0)
          .map((line) => normalizePath(path.resolve(root, line))),
      ),
    );
  }
  return compilerFileCache.get(compilerConfig);
};

const packageBins = (manifest) => {
  if (typeof manifest.bin === "string") {
    return new Map([[manifest.name, manifest.bin]]);
  }
  if (!isPlainObject(manifest.bin)) return new Map();
  return new Map(Object.entries(manifest.bin));
};

const scriptInvokesBinary = (packageJson, scriptName, binary) => {
  const command = packageJson.scripts?.[scriptName];
  if (typeof command !== "string") return false;
  const binaryPattern = new RegExp(
    `(?:^|[\\s;&|()])${escapeRegExp(binary)}(?:\\.cmd)?(?=\\s|$)`,
  );
  return binaryPattern.test(command);
};

const validateCli = async (
  packageName,
  packageJson,
  scriptName,
  binary,
  label,
) => {
  if (!scriptInvokesBinary(packageJson, scriptName, binary)) {
    errors.push(
      `${label}: package script ${scriptName} does not invoke ${binary}`,
    );
    return;
  }
  const { json: manifest } = await directPackageManifest(packageName);
  if (!packageBins(manifest).has(binary)) {
    errors.push(`${label}: ${packageName} does not own CLI ${binary}`);
  }
};

const allowedBuildConfigs = new Map([
  [
    "eslint.config.js",
    { loaderPackage: "eslint", loaderScript: "lint", loaderBinary: "eslint" },
  ],
  [
    "vite.config.ts",
    { loaderPackage: "vite", loaderScript: "dev", loaderBinary: "vite" },
  ],
  [
    "postcss.config.cjs",
    { loaderPackage: "vite", loaderScript: "dev", loaderBinary: "vite" },
  ],
  [
    "vitest.config.ts",
    {
      loaderPackage: "vitest",
      loaderScript: "test:run",
      loaderBinary: "vitest",
    },
  ],
  [
    "vitest.unit.config.ts",
    {
      loaderPackage: "vitest",
      loaderScript: "test:unit",
      loaderBinary: "vitest",
    },
  ],
  [
    "vitest.integration.config.ts",
    {
      loaderPackage: "vitest",
      loaderScript: "test:integration",
      loaderBinary: "vitest",
    },
  ],
  [
    "vitest.worker.config.ts",
    {
      loaderPackage: "vitest",
      loaderScript: "test:worker",
      loaderBinary: "vitest",
    },
  ],
  [
    "playwright.config.ts",
    {
      loaderPackage: "@playwright/test",
      loaderScript: "test:browser",
      loaderBinary: "playwright",
    },
  ],
]);

const validateBuildRoots = async (graphs, packageJson) => {
  const files = [];
  if (!Array.isArray(graphs.buildConfigRoots)) {
    errors.push("policy.graphs.buildConfigRoots must be an array");
    return files;
  }
  for (const [index, entry] of graphs.buildConfigRoots.entries()) {
    const label = `policy.graphs.buildConfigRoots[${index}]`;
    if (
      !assertExactKeys(
        entry,
        ["file", "loaderPackage", "loaderScript", "loaderBinary"],
        label,
      )
    ) {
      continue;
    }
    const allowed = allowedBuildConfigs.get(entry.file);
    if (
      allowed === undefined ||
      Object.entries(allowed).some(([key, value]) => entry[key] !== value)
    ) {
      errors.push(`${label}: unsupported or mismatched default loader binding`);
      continue;
    }
    await validateCli(
      entry.loaderPackage,
      packageJson,
      entry.loaderScript,
      entry.loaderBinary,
      label,
    );
    files.push(entry.file);
  }
  return files;
};

const fileImports = async (file, expectedSpecifier) => {
  const { imports } = await sourceSpecifiers(path.resolve(root, file));
  return imports.has(expectedSpecifier);
};

const validateModuleImport = async (packageName, evidence, graphs, label) => {
  if (
    !assertExactKeys(evidence, ["kind", "graph", "file", "specifier"], label)
  ) {
    return;
  }
  const graph = graphs[evidence.graph];
  const absolutePath = path.resolve(root, evidence.file);
  if (!(graph instanceof Set)) {
    errors.push(`${label}: unknown graph ${evidence.graph}`);
    return;
  }
  if (!graph.has(absolutePath)) {
    errors.push(
      `${label}: ${evidence.file} is not reachable in ${evidence.graph}`,
    );
  }
  if (!(await isFile(absolutePath))) return;
  if (!(await fileImports(evidence.file, evidence.specifier))) {
    errors.push(
      `${label}: ${evidence.file} does not import ${evidence.specifier}`,
    );
  }
  if (packageNameFromSpecifier(evidence.specifier) !== packageName) {
    errors.push(
      `${label}: ${evidence.specifier} does not belong to ${packageName}`,
    );
  }
};

const validateTypeProvider = async (
  packageName,
  evidence,
  graphs,
  packageJson,
  label,
) => {
  if (
    !assertExactKeys(
      evidence,
      [
        "kind",
        "graph",
        "consumerFile",
        "specifier",
        "runtimePackage",
        "compilerConfig",
      ],
      label,
    )
  ) {
    return;
  }
  const expectedTypePackage =
    evidence.runtimePackage === "node"
      ? "@types/node"
      : evidence.runtimePackage.startsWith("@")
        ? `@types/${evidence.runtimePackage.slice(1).replace("/", "__")}`
        : `@types/${evidence.runtimePackage}`;
  if (packageName !== expectedTypePackage) {
    errors.push(
      `${label}: ${packageName} is not the type provider for ${evidence.runtimePackage}`,
    );
  }
  const graph = graphs[evidence.graph];
  const consumerPath = path.resolve(root, evidence.consumerFile);
  if (!(graph instanceof Set) || !graph.has(consumerPath)) {
    errors.push(
      `${label}: ${evidence.consumerFile} is not reachable in ${evidence.graph}`,
    );
  } else if (!(await fileImports(evidence.consumerFile, evidence.specifier))) {
    errors.push(
      `${label}: ${evidence.consumerFile} does not import ${evidence.specifier}`,
    );
  }
  if (
    evidence.runtimePackage === "node"
      ? !evidence.specifier.startsWith("node:")
      : packageNameFromSpecifier(evidence.specifier) !== evidence.runtimePackage
  ) {
    errors.push(`${label}: consumer specifier does not match runtime package`);
  }

  const compilerConfigPath = path.resolve(root, evidence.compilerConfig);
  if (!(await isFile(compilerConfigPath))) {
    errors.push(`${label}: compiler config is missing`);
  } else {
    const compilerConfig = await readJson(
      compilerConfigPath,
      evidence.compilerConfig,
    );
    const includes = Array.isArray(compilerConfig.include)
      ? compilerConfig.include
      : [];
    const normalizedConsumer = normalizePath(evidence.consumerFile);
    const included = includes.some((include) => {
      const normalizedInclude = normalizePath(include).replace(/\/+$/, "");
      return (
        normalizedConsumer === normalizedInclude ||
        normalizedConsumer.startsWith(`${normalizedInclude}/`) ||
        (normalizedInclude.includes("*") &&
          new RegExp(
            `^${escapeRegExp(normalizedInclude)
              .replaceAll("\\*\\*/", "(?:.*/)?")
              .replaceAll("\\*", "[^/]*")}$`,
          ).test(normalizedConsumer))
      );
    });
    if (!included) {
      errors.push(
        `${label}: ${evidence.consumerFile} is not included by ${evidence.compilerConfig}`,
      );
    }
    const typecheck = packageJson.scripts?.typecheck ?? "";
    const configInvoked =
      evidence.compilerConfig === "tsconfig.json"
        ? /(?:^|&&)\s*tsc\s+--noEmit(?:\s|$)/.test(typecheck)
        : new RegExp(
            `\\btsc\\s+(?:--noEmit\\s+)?-p\\s+${escapeRegExp(evidence.compilerConfig)}(?:\\s|$)`,
          ).test(typecheck);
    if (!configInvoked) {
      errors.push(
        `${label}: typecheck does not invoke ${evidence.compilerConfig}`,
      );
    }
    if (
      /\.(?:c|m)?js$/.test(evidence.consumerFile) &&
      (compilerConfig.compilerOptions?.allowJs !== true ||
        compilerConfig.compilerOptions?.checkJs !== true)
    ) {
      errors.push(
        `${label}: JavaScript type consumer requires allowJs/checkJs`,
      );
    }
    const declarationDirectory = `/node_modules/${packageName}/`;
    if (
      ![...compilerFiles(evidence.compilerConfig)].some((file) =>
        file.includes(declarationDirectory),
      )
    ) {
      errors.push(
        `${label}: TypeScript resolution did not load ${packageName}`,
      );
    }
  }

  const { json: typeManifest } = await directPackageManifest(packageName);
  if (
    typeof typeManifest.types !== "string" &&
    typeof typeManifest.typings !== "string"
  ) {
    errors.push(`${label}: ${packageName} exposes no declaration entry`);
  }
  if (evidence.runtimePackage !== "node") {
    const { json: runtimeManifest } = await directPackageManifest(
      evidence.runtimePackage,
    );
    if (
      typeof runtimeManifest.types === "string" ||
      typeof runtimeManifest.typings === "string"
    ) {
      errors.push(
        `${label}: ${evidence.runtimePackage} already owns its declarations`,
      );
    }
  }
};

const resolveFromPackage = (ownerPackage, targetPackage) => {
  const ownerManifestPath = path.join(
    root,
    "node_modules",
    ...ownerPackage.split("/"),
    "package.json",
  );
  return createRequire(ownerManifestPath).resolve(
    `${targetPackage}/package.json`,
  );
};

const validatePostcssPlugin = async (packageName, evidence, graphs, label) => {
  if (
    !assertExactKeys(
      evidence,
      ["kind", "graph", "configFile", "configKey", "loaderPackage"],
      label,
    )
  ) {
    return;
  }
  const configPath = path.resolve(root, evidence.configFile);
  if (!graphs[evidence.graph]?.has(configPath)) {
    errors.push(
      `${label}: ${evidence.configFile} is not reachable in ${evidence.graph}`,
    );
  }
  const source = await readText(configPath);
  if (
    !new RegExp(
      `(?:^|[,{]\\s*)${escapeRegExp(evidence.configKey)}\\s*:`,
      "m",
    ).test(source)
  ) {
    errors.push(`${label}: PostCSS config key ${evidence.configKey} is absent`);
  }
  if (evidence.configKey !== packageName) {
    errors.push(`${label}: config key does not identify ${packageName}`);
  }
  const { json: manifest } = await directPackageManifest(packageName);
  const loaderRange =
    manifest.peerDependencies?.[evidence.loaderPackage] ??
    manifest.dependencies?.[evidence.loaderPackage];
  if (typeof loaderRange !== "string") {
    errors.push(
      `${label}: ${packageName} does not declare ${evidence.loaderPackage}`,
    );
  }
  const directLoaderPath = (await directPackageManifest(evidence.loaderPackage))
    .path;
  let resolvedLoaderPath;
  try {
    resolvedLoaderPath = resolveFromPackage(
      packageName,
      evidence.loaderPackage,
    );
  } catch {
    resolvedLoaderPath = null;
  }
  if (
    resolvedLoaderPath === null ||
    path.resolve(resolvedLoaderPath) !== path.resolve(directLoaderPath)
  ) {
    errors.push(
      `${label}: ${packageName} does not resolve the pinned direct ${evidence.loaderPackage}`,
    );
  }
};

const validateDependencyHost = async (packageName, evidence, graphs, label) => {
  if (
    !assertExactKeys(
      evidence,
      ["kind", "graph", "configFile", "hostPackage"],
      label,
    )
  ) {
    return;
  }
  const configPath = path.resolve(root, evidence.configFile);
  if (!graphs[evidence.graph]?.has(configPath)) {
    errors.push(
      `${label}: ${evidence.configFile} is not reachable in ${evidence.graph}`,
    );
  }
  const { json: hostManifest } = await directPackageManifest(
    evidence.hostPackage,
  );
  const range =
    hostManifest.dependencies?.[packageName] ??
    hostManifest.peerDependencies?.[packageName] ??
    hostManifest.optionalDependencies?.[packageName];
  if (typeof range !== "string") {
    errors.push(
      `${label}: ${evidence.hostPackage} does not declare ${packageName}`,
    );
  }
  const directManifestPath = (await directPackageManifest(packageName)).path;
  let resolvedManifestPath;
  try {
    resolvedManifestPath = resolveFromPackage(
      evidence.hostPackage,
      packageName,
    );
  } catch {
    resolvedManifestPath = null;
  }
  if (
    resolvedManifestPath === null ||
    path.resolve(resolvedManifestPath) !== path.resolve(directManifestPath)
  ) {
    errors.push(
      `${label}: ${evidence.hostPackage} does not resolve pinned direct ${packageName}`,
    );
  }
};

const validateVitestProvider = async (
  packageName,
  evidence,
  graphs,
  packageJson,
  label,
) => {
  if (
    !assertKeys(
      evidence,
      [
        "kind",
        "providerType",
        "graph",
        "configFile",
        "configValue",
        "activationScript",
        "activationFile",
      ],
      label,
    )
  ) {
    return;
  }
  const required =
    evidence.providerType === "coverage"
      ? [
          "kind",
          "providerType",
          "graph",
          "configFile",
          "configValue",
          "activationScript",
          "activationFile",
        ]
      : [
          "kind",
          "providerType",
          "graph",
          "configFile",
          "configValue",
          "activationScript",
        ];
  if (!assertExactKeys(evidence, required, label)) return;
  const configPath = path.resolve(root, evidence.configFile);
  if (!graphs[evidence.graph]?.has(configPath)) {
    errors.push(
      `${label}: ${evidence.configFile} is not reachable in ${evidence.graph}`,
    );
  }
  const configSource = await readText(configPath);
  if (evidence.providerType === "environment") {
    if (
      packageName !== evidence.configValue ||
      !new RegExp(
        `\\benvironment\\s*:\\s*["']${escapeRegExp(evidence.configValue)}["']`,
      ).test(configSource)
    ) {
      errors.push(`${label}: Vitest environment binding is absent`);
    }
  } else if (evidence.providerType === "coverage") {
    if (packageName !== `@vitest/coverage-${evidence.configValue}`) {
      errors.push(`${label}: Vitest coverage package name is mismatched`);
    }
    const config = await readJson(configPath, evidence.configFile);
    if (config.provider !== evidence.configValue) {
      errors.push(`${label}: coverage provider value is mismatched`);
    }
    const activationPath = path.resolve(root, evidence.activationFile);
    if (!graphs["release-tool"]?.has(activationPath)) {
      errors.push(
        `${label}: ${evidence.activationFile} is not release-tool reachable`,
      );
    } else {
      const activationSource = await readText(activationPath);
      if (
        !activationSource.includes('"--coverage"') ||
        !activationSource.includes('"vitest"')
      ) {
        errors.push(`${label}: coverage activation is not explicit`);
      }
    }
  } else {
    errors.push(`${label}: unsupported Vitest provider type`);
  }
  if (!scriptInvokesBinary(packageJson, evidence.activationScript, "vitest")) {
    const command = packageJson.scripts?.[evidence.activationScript] ?? "";
    const activationFile =
      evidence.activationFile === undefined
        ? null
        : normalizePath(evidence.activationFile);
    if (
      activationFile === null ||
      !normalizePath(command).includes(activationFile)
    ) {
      errors.push(
        `${label}: activation script ${evidence.activationScript} is not bound to Vitest`,
      );
    }
  }
};

const validatePackageBinPath = async (
  packageName,
  evidence,
  graphs,
  packageJson,
  label,
) => {
  if (
    !assertExactKeys(
      evidence,
      [
        "kind",
        "graph",
        "consumerFile",
        "script",
        "binary",
        "variable",
        "pathSegments",
      ],
      label,
    )
  ) {
    return;
  }
  if (
    !Array.isArray(evidence.pathSegments) ||
    evidence.pathSegments.some(
      (segment) => typeof segment !== "string" || segment.length === 0,
    )
  ) {
    errors.push(`${label}: pathSegments must be non-empty strings`);
    return;
  }
  const consumerPath = path.resolve(root, evidence.consumerFile);
  if (!graphs[evidence.graph]?.has(consumerPath)) {
    errors.push(
      `${label}: ${evidence.consumerFile} is not reachable in ${evidence.graph}`,
    );
  }
  const scriptCommand = normalizePath(
    packageJson.scripts?.[evidence.script] ?? "",
  );
  if (!scriptCommand.includes(normalizePath(evidence.consumerFile))) {
    errors.push(
      `${label}: package script ${evidence.script} does not invoke consumer`,
    );
  }
  const source = await readText(consumerPath);
  let previousIndex = -1;
  for (const segment of evidence.pathSegments) {
    const index = source.indexOf(`"${segment}"`, previousIndex + 1);
    if (index < 0) {
      errors.push(`${label}: consumer path segment ${segment} is absent`);
      break;
    }
    previousIndex = index;
  }
  if (
    !new RegExp(
      `spawnSync\\s*\\([\\s\\S]{0,300}\\[${escapeRegExp(evidence.variable)}\\s*,`,
    ).test(source)
  ) {
    errors.push(`${label}: pinned CLI variable is not executed`);
  }
  const { json: manifest } = await directPackageManifest(packageName);
  const binPath = packageBins(manifest).get(evidence.binary);
  const packageIndex = evidence.pathSegments.indexOf(packageName);
  const declaredPath =
    packageIndex < 0
      ? null
      : evidence.pathSegments.slice(packageIndex + 1).join("/");
  if (
    typeof binPath !== "string" ||
    normalizePath(binPath).replace(/^\.\//, "") !== declaredPath
  ) {
    errors.push(`${label}: constructed path is not the owned package CLI`);
  }
};

const packageJson = await readJson(
  path.join(root, "package.json"),
  "package.json",
);
const policy = await readJson(policyPath, "direct dependency usage policy");
if (
  !assertExactKeys(policy, ["schemaVersion", "graphs", "packages"], "policy")
) {
  fail(errors.join("\n"));
  process.exit();
}
if (policy.schemaVersion !== 1) {
  errors.push("policy.schemaVersion must equal 1");
}
assertExactKeys(
  policy.graphs,
  ["productionRoots", "buildConfigRoots", "testSetupRoots"],
  "policy.graphs",
);
if (!Array.isArray(policy.graphs.productionRoots)) {
  errors.push("policy.graphs.productionRoots must be an array");
}
if (!Array.isArray(policy.graphs.testSetupRoots)) {
  errors.push("policy.graphs.testSetupRoots must be an array");
}

const buildRoots = await validateBuildRoots(policy.graphs, packageJson);
const sourceTests = (await walkFiles(path.join(root, "src")))
  .filter((file) => /\.test\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file))
  .map(relativePath);
const browserTests = (await walkFiles(path.join(root, "tests", "browser")))
  .filter((file) => /\.spec\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file))
  .map(relativePath);
const graphRoots = {
  production: policy.graphs.productionRoots ?? [],
  "release-tool": scriptEntrypoints(packageJson),
  test: sorted([
    ...sourceTests,
    ...browserTests,
    ...(policy.graphs.testSetupRoots ?? []),
  ]),
  build: buildRoots,
};
const graphs = Object.fromEntries(
  await Promise.all(
    Object.entries(graphRoots).map(async ([name, roots]) => [
      name,
      await collectGraph(name, roots),
    ]),
  ),
);

const directDependencies = new Map([
  ...Object.entries(packageJson.dependencies ?? {}).map(([name, version]) => [
    name,
    { scope: "dependencies", version },
  ]),
  ...Object.entries(packageJson.devDependencies ?? {}).map(
    ([name, version]) => [name, { scope: "devDependencies", version }],
  ),
]);
if (!isPlainObject(policy.packages)) {
  errors.push("policy.packages must be an object");
} else {
  const configuredOrder = Object.keys(policy.packages);
  if (configuredOrder.join("\n") !== sorted(configuredOrder).join("\n")) {
    errors.push("policy.packages keys must use UTF-8 lexical order");
  }
  const missing = sorted(
    [...directDependencies.keys()].filter(
      (name) => !Object.prototype.hasOwnProperty.call(policy.packages, name),
    ),
  );
  const unknown = sorted(
    Object.keys(policy.packages).filter(
      (name) => !directDependencies.has(name),
    ),
  );
  if (missing.length > 0) {
    errors.push(
      `unknown direct dependencies (no policy): ${missing.join(", ")}`,
    );
  }
  if (unknown.length > 0) {
    errors.push(
      `policy packages are not direct dependencies: ${unknown.join(", ")}`,
    );
  }
}

for (const [packageName, direct] of sorted(directDependencies.keys()).map(
  (name) => [name, directDependencies.get(name)],
)) {
  const entry = policy.packages?.[packageName];
  const label = `policy.packages[${JSON.stringify(packageName)}]`;
  if (!assertExactKeys(entry, ["scope", "evidence"], label)) continue;
  if (entry.scope !== direct.scope) {
    errors.push(`${label}: scope must be ${direct.scope}`);
  }
  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
    errors.push(`${label}: evidence must not be empty`);
    continue;
  }
  try {
    const { json: manifest } = await directPackageManifest(packageName);
    if (manifest.name !== packageName || manifest.version !== direct.version) {
      errors.push(
        `${label}: installed manifest does not match ${packageName}@${direct.version}`,
      );
    }
  } catch (error) {
    errors.push(
      `${label}: installed manifest is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    continue;
  }

  let hasProductionImport = false;
  for (const [index, evidence] of entry.evidence.entries()) {
    const evidenceLabel = `${label}.evidence[${index}]`;
    if (!isPlainObject(evidence) || typeof evidence.kind !== "string") {
      errors.push(`${evidenceLabel}: evidence kind is required`);
      continue;
    }
    try {
      switch (evidence.kind) {
        case "module-import":
          await validateModuleImport(
            packageName,
            evidence,
            graphs,
            evidenceLabel,
          );
          hasProductionImport ||= evidence.graph === "production";
          break;
        case "cli":
          if (
            assertExactKeys(
              evidence,
              ["kind", "script", "binary"],
              evidenceLabel,
            )
          ) {
            await validateCli(
              packageName,
              packageJson,
              evidence.script,
              evidence.binary,
              evidenceLabel,
            );
          }
          break;
        case "type-provider":
          await validateTypeProvider(
            packageName,
            evidence,
            graphs,
            packageJson,
            evidenceLabel,
          );
          break;
        case "postcss-plugin":
          await validatePostcssPlugin(
            packageName,
            evidence,
            graphs,
            evidenceLabel,
          );
          break;
        case "dependency-host":
          await validateDependencyHost(
            packageName,
            evidence,
            graphs,
            evidenceLabel,
          );
          break;
        case "vitest-provider":
          await validateVitestProvider(
            packageName,
            evidence,
            graphs,
            packageJson,
            evidenceLabel,
          );
          break;
        case "package-bin-path":
          await validatePackageBinPath(
            packageName,
            evidence,
            graphs,
            packageJson,
            evidenceLabel,
          );
          break;
        default:
          errors.push(`${evidenceLabel}: unsupported evidence kind`);
      }
    } catch (error) {
      errors.push(
        `${evidenceLabel}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (entry.scope === "dependencies" && !hasProductionImport) {
    errors.push(`${label}: runtime dependency needs a production import`);
  }
}

if (errors.length > 0) {
  fail(errors.map((error) => `- ${error}`).join("\n"));
} else {
  const graphSummary = Object.entries(graphs)
    .map(([name, files]) => `${name}=${files.size}`)
    .join(", ");
  process.stdout.write(
    `PASS direct dependency usage: ${directDependencies.size} known, 0 unknown, 0 unused; ${graphSummary}\n`,
  );
}
