import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { runManagedDeviceCollectorCli } from "./collect-managed-device-authority.mjs";

export const runIdbDeviceCompatibilityCollector = (
  options = {},
  dependencies = {},
  runCollector = runManagedDeviceCollectorCli,
) => {
  const { argv = process.argv.slice(2), ...runtime } = options;
  return runCollector(
    {
      ...runtime,
      argv: ["--authority", "idb-device-compatibility", ...argv],
    },
    dependencies,
  );
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await runIdbDeviceCompatibilityCollector();
