#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalJsonBytes,
  readJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import { assertVercelObservationEvidence } from "../provider/collect-vercel-observation.mjs";
import {
  assertRemoteDbObservationAuthority,
  collectRemoteDbObservation,
} from "./remote-db-observation.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const migrationDirectory = path.join(repositoryRoot, "supabase", "migrations");
const FLAGS = Object.freeze(["--output", "--provider-observation"]);

const requireEnvironment = (environment, name) => {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Required remote DB observer environment is absent: ${name}`,
    );
  }
  return value;
};

export const parseRemoteDbObservationArguments = (argv) => {
  if (!Array.isArray(argv) || argv.length !== FLAGS.length * 2) {
    throw new Error(
      "Usage: collect-remote-db-observation.mjs --provider-observation <json> --output <json>",
    );
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !FLAGS.includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error(`Invalid or duplicate remote DB collector flag: ${flag}`);
    }
    values.set(flag, value);
  }
  if (values.size !== FLAGS.length) {
    throw new Error("Remote DB collector arguments are incomplete");
  }
  return {
    output: values.get("--output"),
    providerObservation: values.get("--provider-observation"),
  };
};

const resolveCliPaths = (argv, workingDirectory) => {
  const parsed = parseRemoteDbObservationArguments(argv);
  const paths = {
    output: path.resolve(workingDirectory, parsed.output),
    providerObservation: path.resolve(
      workingDirectory,
      parsed.providerObservation,
    ),
  };
  const comparable = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  if (comparable(paths.output) === comparable(paths.providerObservation)) {
    throw new Error(
      "Remote DB observation output must differ from provider observation input",
    );
  }
  return paths;
};

const productionConnectionBinding = (connectionString, ca, authority) => {
  assertRemoteDbObservationAuthority(authority, { requireConfigured: true });
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("Remote DB observer URL is invalid");
  }
  let database;
  let observerRole;
  try {
    database = decodeURIComponent(parsed.pathname.slice(1));
    observerRole = decodeURIComponent(parsed.username);
  } catch {
    throw new Error("Remote DB observer URL authority is invalid");
  }
  const queryNames = [...new Set(parsed.searchParams.keys())];
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    parsed.username.length === 0 ||
    parsed.password.length === 0 ||
    parsed.pathname === "" ||
    parsed.pathname === "/" ||
    parsed.hash !== "" ||
    queryNames.length !== 1 ||
    queryNames[0] !== "sslmode" ||
    parsed.searchParams.getAll("sslmode").length !== 1 ||
    parsed.searchParams.get("sslmode") !== authority.tlsMode ||
    parsed.pathname.slice(1).includes("/") ||
    !authority.allowedHosts.includes(parsed.hostname) ||
    !authority.allowedDatabases.includes(database) ||
    !authority.allowedObserverRoles.includes(observerRole) ||
    sha256Bytes(Buffer.from(ca, "utf8")) !== authority.productionCaSha256
  ) {
    throw new Error("Remote DB observer connection authority is invalid");
  }
  const runtimeUrl = new URL(parsed);
  runtimeUrl.searchParams.delete("sslmode");
  return {
    observerRole,
    clientOptions: {
      connectionString: runtimeUrl.toString(),
      ssl: { ca, rejectUnauthorized: true },
      connectionTimeoutMillis: authority.connectTimeoutMilliseconds,
      statement_timeout: authority.statementTimeoutMilliseconds,
      application_name: "event-shopping-planner-db-observer",
    },
  };
};

const defaultCreateClient = async (options) => {
  const { Client } = await import("pg");
  return new Client(options);
};

const readMigrationChecksums = async ({
  contract,
  readFileImpl,
  migrationsRoot = migrationDirectory,
}) => {
  const names = Object.keys(contract.remote?.migrationChecksums ?? {}).sort();
  if (names.length === 0) {
    throw new Error("Remote DB migration authority is absent");
  }
  const entries = await Promise.all(
    names.map(async (name) => {
      if (path.basename(name) !== name || !/^[a-zA-Z0-9_.-]+$/u.test(name)) {
        throw new Error("Remote DB migration path is invalid");
      }
      const bytes = await readFileImpl(path.join(migrationsRoot, name));
      return [name, sha256Bytes(bytes)];
    }),
  );
  return Object.fromEntries(entries);
};

export const runRemoteDbObservationCli = async (
  {
    argv = process.argv.slice(2),
    env = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadJson = readJsonStrict,
    readFileImpl = readFile,
    writeFileImpl = writeFile,
    createClient = defaultCreateClient,
    validateProviderObservation = assertVercelObservationEvidence,
    collectObservation = collectRemoteDbObservation,
    now = Date.now,
  } = {},
) => {
  const paths = resolveCliPaths(argv, cwd);
  const [contract, providerPolicy, providerObservation] = await Promise.all([
    loadJson(
      path.join(repositoryRoot, "config", "db-compatibility-contract.json"),
    ),
    loadJson(path.join(repositoryRoot, "config", "provider-policy.json")),
    loadJson(paths.providerObservation),
  ]);
  const authority = assertRemoteDbObservationAuthority(
    contract.remote?.observationAuthority,
    { requireConfigured: true },
  );
  validateProviderObservation(providerObservation, providerPolicy, now);
  const migrationChecksums = await readMigrationChecksums({
    contract,
    readFileImpl,
  });
  const connectionString = requireEnvironment(
    env,
    authority.databaseUrlEnvironmentName,
  );
  const ca = requireEnvironment(env, authority.databaseCaEnvironmentName);
  const connection = productionConnectionBinding(
    connectionString,
    ca,
    authority,
  );
  const client = await createClient(connection.clientOptions);
  let connected = false;
  let evidence;
  try {
    await client.connect();
    connected = true;
    evidence = await collectObservation({
      client,
      contract,
      migrationChecksums,
      providerPolicy,
      providerObservation,
      expectedObserverRole: connection.observerRole,
      now,
    });
  } finally {
    if (connected) await client.end();
  }
  const bytes = canonicalJsonBytes(evidence);
  await writeFileImpl(paths.output, bytes, {
    flag: "wx",
    mode: 0o600,
  });
  const sha256 = sha256Bytes(bytes);
  stdout.write(`PASS wrote remote DB observation ${sha256}\n`);
  return { evidence, bytes, sha256, outputPath: paths.output };
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runRemoteDbObservationCli().catch(() => {
    process.stderr.write("Remote DB observation failed\n");
    process.exitCode = 1;
  });
}
