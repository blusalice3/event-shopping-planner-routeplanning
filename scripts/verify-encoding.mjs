#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  fail,
  normalizePath,
  projectRoot,
  readJson,
  utf8Compare,
} from "./foundation-policy-utils.mjs";

const policy = await readJson("config/encoding-policy.json");
const extensions = new Set(policy.textExtensions);
const errors = [];
const files = new Set();

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(absolutePath);
    } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      files.add(absolutePath);
    }
  }
}

for (const root of policy.scanRoots) {
  const absoluteRoot = path.resolve(projectRoot, root);
  try {
    if ((await stat(absoluteRoot)).isDirectory())
      await collectFiles(absoluteRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

for (const rootFile of policy.rootFiles) {
  const absolutePath = path.resolve(projectRoot, rootFile);
  try {
    if ((await stat(absolutePath)).isFile()) files.add(absolutePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    errors.push(`${normalizePath(rootFile)}: policy root file is missing`);
  }
}

const representativeMatches = new Map(
  policy.requiredRepresentativeStrings.map((value) => [value, 0]),
);
const mojibakePattern = new RegExp(policy.suspiciousMojibakePattern, "u");
const questionMarkPattern = new RegExp(
  policy.suspiciousQuestionMarkPattern,
  "u",
);
let questionMarkCount = 0;
let lfFileCount = 0;
let crlfFileCount = 0;
let noNewlineFileCount = 0;

const sortedFiles = [...files].sort((left, right) =>
  utf8Compare(
    normalizePath(path.relative(projectRoot, left)),
    normalizePath(path.relative(projectRoot, right)),
  ),
);

for (const filePath of sortedFiles) {
  const displayPath = normalizePath(path.relative(projectRoot, filePath));
  const bytes = await readFile(filePath);
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    errors.push(`${displayPath}: unexpected UTF-8 BOM`);
  }

  let text;
  try {
    text = new TextDecoder(policy.encoding, { fatal: true }).decode(bytes);
  } catch {
    errors.push(`${displayPath}: invalid ${policy.encoding.toUpperCase()}`);
    continue;
  }

  if (text.includes("\uFFFD")) {
    errors.push(`${displayPath}: contains U+FFFD`);
  }
  if (mojibakePattern.test(text)) {
    errors.push(`${displayPath}: contains a likely mojibake sequence`);
  }
  if (questionMarkPattern.test(text)) {
    errors.push(`${displayPath}: contains a suspicious question-mark sequence`);
  }

  const crlfCount = text.match(/\r\n/g)?.length ?? 0;
  const withoutCrlf = text.replaceAll("\r\n", "");
  const bareLfCount = withoutCrlf.match(/\n/g)?.length ?? 0;
  const bareCrCount = withoutCrlf.match(/\r/g)?.length ?? 0;
  const expectedEol = policy.eolExceptions[displayPath] ?? policy.defaultEol;

  if (bareCrCount > 0) {
    errors.push(`${displayPath}: contains a bare CR newline`);
  }
  if (crlfCount > 0 && bareLfCount > 0) {
    errors.push(`${displayPath}: contains mixed CRLF and LF newlines`);
  }
  if (expectedEol === "lf" && crlfCount > 0) {
    errors.push(`${displayPath}: expected LF but found CRLF`);
  }
  if (expectedEol === "crlf" && bareLfCount > 0) {
    errors.push(`${displayPath}: expected CRLF but found bare LF`);
  }

  if (crlfCount > 0) {
    crlfFileCount += 1;
  } else if (bareLfCount > 0) {
    lfFileCount += 1;
  } else {
    noNewlineFileCount += 1;
  }

  questionMarkCount += text.match(/\?/g)?.length ?? 0;
  for (const representative of policy.requiredRepresentativeStrings) {
    const occurrences = text.split(representative).length - 1;
    representativeMatches.set(
      representative,
      (representativeMatches.get(representative) ?? 0) + occurrences,
    );
  }
}

for (const [representative, count] of representativeMatches) {
  if (count === 0) {
    errors.push(`representative string is missing: ${representative}`);
  }
}

if (errors.length > 0) {
  fail("FAIL encoding verification", errors);
} else {
  process.stdout.write(
    [
      `PASS encoding verification: ${sortedFiles.length} text files`,
      "UTF-8 without BOM; U+FFFD/mojibake/suspicious '?' absent",
      `newlines: LF=${lfFileCount}, CRLF=${crlfFileCount}, none=${noNewlineFileCount}`,
      `question marks reviewed=${questionMarkCount}`,
      `representative strings: ${[...representativeMatches.entries()]
        .map(([value, count]) => `${value}=${count}`)
        .join(", ")}`,
    ].join("; ") + "\n",
  );
}
