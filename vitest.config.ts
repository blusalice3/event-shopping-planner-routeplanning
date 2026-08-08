import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

interface CoverageThresholds {
  readonly branches: number;
  readonly functions: number;
  readonly lines: number;
  readonly statements: number;
}

interface CoveragePolicy {
  readonly provider: "v8";
  readonly reportsDirectory: string;
  readonly reporters: Array<"text" | "json-summary" | "lcov">;
  readonly include: string[];
  readonly exclude: string[];
  readonly globalThresholds: CoverageThresholds;
  readonly subsystemThresholds: Array<
    CoverageThresholds & {
      readonly id: string;
      readonly requiredFromExit: string;
      readonly vitestGlobs: string[];
    }
  >;
}

const coveragePolicy = JSON.parse(
  readFileSync(
    new URL("./config/coverage-policy.json", import.meta.url),
    "utf8",
  ),
) as CoveragePolicy;

const subsystemThresholds = Object.fromEntries(
  coveragePolicy.subsystemThresholds.flatMap((subsystem) =>
    subsystem.vitestGlobs.map((glob) => [
      glob,
      {
        branches: subsystem.branches,
        functions: subsystem.functions,
        lines: subsystem.lines,
        statements: subsystem.statements,
      },
    ]),
  ),
);

export default defineConfig({
  test: {
    projects: [
      "./vitest.unit.config.ts",
      "./vitest.integration.config.ts",
      "./vitest.worker.config.ts",
    ],
    coverage: {
      provider: coveragePolicy.provider,
      reportsDirectory: coveragePolicy.reportsDirectory,
      reporter: coveragePolicy.reporters,
      include: coveragePolicy.include,
      exclude: coveragePolicy.exclude,
      thresholds: {
        ...coveragePolicy.globalThresholds,
        ...subsystemThresholds,
      },
    },
  },
});
