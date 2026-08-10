#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  fail,
  normalizePath,
  projectRoot,
  readJson,
  utf8Compare,
} from "./foundation-policy-utils.mjs";

const policy = await readJson("config/test-project-membership.json");
const packageJson = await readJson("package.json");
const errors = [];
const testFilePattern = new RegExp(policy.testFileRegex);
const files = [];

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(absolutePath);
    } else if (entry.isFile()) {
      const displayPath = normalizePath(
        path.relative(projectRoot, absolutePath),
      );
      if (testFilePattern.test(displayPath)) files.push(displayPath);
    }
  }
}

for (const root of policy.roots) await collect(path.resolve(projectRoot, root));
files.sort(utf8Compare);

const projectCounts = Object.fromEntries(
  policy.projects.map((project) => [project.name, 0]),
);

for (const file of files) {
  const memberships = policy.projects.filter((project) => {
    const included = new RegExp(project.includeRegex).test(file);
    const excluded =
      project.excludeRegex !== null &&
      new RegExp(project.excludeRegex).test(file);
    return included && !excluded;
  });
  if (memberships.length !== 1) {
    errors.push(
      `${file}: expected exactly one project, matched ${memberships.map(({ name }) => name).join(", ") || "none"}`,
    );
    continue;
  }
  projectCounts[memberships[0].name] += 1;
}

for (const project of policy.projects) {
  const script = packageJson.scripts?.[project.packageScript];
  if (
    typeof script !== "string" ||
    !script.includes(`--project ${project.name}`)
  ) {
    errors.push(
      `${project.packageScript}: must select Vitest project ${project.name}`,
    );
  }
  let configText = "";
  try {
    configText = await readFile(path.resolve(projectRoot, project.configPath), {
      encoding: "utf8",
    });
  } catch {
    errors.push(`${project.configPath}: project config is missing`);
  }
  if (!configText.includes(`name: "${project.name}"`)) {
    errors.push(`${project.configPath}: project name is not explicit`);
  }
  if (!project.allowEmpty && projectCounts[project.name] === 0) {
    errors.push(`${project.name}: project unexpectedly has no tests`);
  }
}

if (files.length < policy.expectedBaseline.totalFiles) {
  errors.push(
    `test inventory regressed from ${policy.expectedBaseline.totalFiles} to ${files.length}`,
  );
}
for (const [name, baselineCount] of Object.entries(
  policy.expectedBaseline.projectCounts,
)) {
  if ((projectCounts[name] ?? 0) < baselineCount) {
    errors.push(
      `${name}: membership regressed from ${baselineCount} to ${projectCounts[name] ?? 0}`,
    );
  }
}

if (errors.length > 0) {
  fail("FAIL test project membership", errors);
} else {
  process.stdout.write(
    `PASS test project membership: ${files.length} files; ${Object.entries(
      projectCounts,
    )
      .sort(([left], [right]) => utf8Compare(left, right))
      .map(([name, count]) => `${name}=${count}`)
      .join(", ")}\n`,
  );
}
