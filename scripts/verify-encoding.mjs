#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

const PROJECT_ROOT = process.cwd();
const SCAN_ROOTS = ["src", "docs", "scripts", "api", "supabase"];
const ROOT_FILES = [
  "README.md",
  "package.json",
  "vercel.json",
  "vite.config.ts",
];
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ps1",
  ".sql",
  ".ts",
  ".tsx",
]);
const REQUIRED_REPRESENTATIVE_STRINGS = [
  "ユーザー登録",
  "エラーが発生しました",
];
const SUSPICIOUS_MOJIBAKE =
  /(?:繧[ァ-ヶ]|繝[ァ-ヶ]|縺[ぁ-ん]|譁\uFFFD|陦\uFFFD|蜿\uFFFD|隱\uFFFD|髫\uFFFD)/u;
const SUSPICIOUS_QUESTION_MARK =
  /(?:[ぁ-んァ-ヶ一-龠々〆ヵヶ]\?[ぁ-んァ-ヶ一-龠々〆ヵヶ]|\?{3,})/u;

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath)));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) {
      files.push(absolutePath);
    }
  }
  return files;
}

const files = [];
for (const root of SCAN_ROOTS) {
  try {
    files.push(...(await collectFiles(resolve(PROJECT_ROOT, root))));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
for (const rootFile of ROOT_FILES) {
  files.push(resolve(PROJECT_ROOT, rootFile));
}
files.sort((left, right) => left.localeCompare(right));

const errors = [];
const representativeMatches = new Map(
  REQUIRED_REPRESENTATIVE_STRINGS.map((value) => [value, 0]),
);
let questionMarkCount = 0;
let lfFileCount = 0;
let crlfFileCount = 0;
let noNewlineFileCount = 0;

for (const filePath of files) {
  const displayPath = relative(PROJECT_ROOT, filePath).replaceAll("\\", "/");
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    errors.push(`${displayPath}: cannot be read (${error?.code ?? "error"})`);
    continue;
  }

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
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    errors.push(`${displayPath}: invalid UTF-8`);
    continue;
  }

  if (text.includes("\uFFFD")) {
    errors.push(`${displayPath}: contains U+FFFD`);
  }
  if (SUSPICIOUS_MOJIBAKE.test(text)) {
    errors.push(`${displayPath}: contains a likely mojibake sequence`);
  }
  if (SUSPICIOUS_QUESTION_MARK.test(text)) {
    errors.push(`${displayPath}: contains a suspicious question-mark sequence`);
  }

  const crlfCount = text.match(/\r\n/g)?.length ?? 0;
  const withoutCrlf = text.replaceAll("\r\n", "");
  const bareLfCount = withoutCrlf.match(/\n/g)?.length ?? 0;
  const bareCrCount = withoutCrlf.match(/\r/g)?.length ?? 0;
  if (bareCrCount > 0) {
    errors.push(`${displayPath}: contains a bare CR newline`);
  }
  if (crlfCount > 0 && bareLfCount > 0) {
    errors.push(`${displayPath}: contains mixed CRLF and LF newlines`);
  }
  if (crlfCount > 0) {
    crlfFileCount += 1;
  } else if (bareLfCount > 0) {
    lfFileCount += 1;
  } else {
    noNewlineFileCount += 1;
  }

  questionMarkCount += text.match(/\?/g)?.length ?? 0;
  for (const representative of REQUIRED_REPRESENTATIVE_STRINGS) {
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
  console.error(`FAIL encoding verification (${errors.length} issue(s))`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    [
      `PASS encoding verification: ${files.length} text files`,
      `UTF-8 without BOM; U+FFFD/mojibake/suspicious '?' absent`,
      `newlines: LF=${lfFileCount}, CRLF=${crlfFileCount}, none=${noNewlineFileCount}`,
      `question marks reviewed=${questionMarkCount}`,
      `representative strings: ${[...representativeMatches.entries()]
        .map(([value, count]) => `${value}=${count}`)
        .join(", ")}`,
    ].join("; "),
  );
}
