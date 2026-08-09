import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const APPLICATION_STYLESHEET_PATH_PATTERN =
  /^\/assets\/[A-Za-z0-9][A-Za-z0-9._/-]*\.css$/u;
const LOADING_SCREEN_BASE_RULE =
  /#loading-screen\s*\{[^}]*\bdisplay\s*:\s*flex\s*;?[^}]*\}/u;
const LOADING_SCREEN_HIDDEN_RULE =
  /#loading-screen\.hidden\s*\{[^}]*\bdisplay\s*:\s*none\s*;?[^}]*\}/u;

const toBuffer = (source) => {
  if (typeof source === "string") return Buffer.from(source, "utf8");
  if (source instanceof Uint8Array) return Buffer.from(source);
  throw new TypeError(
    "Application stylesheet bytes must be text or Uint8Array",
  );
};

const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

const readAttribute = (tag, name) => {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "iu",
  ).exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
};

export const hasStaticApplicationStylesheetContract = (source) => {
  const css = toBuffer(source).toString("utf8");
  return (
    LOADING_SCREEN_BASE_RULE.test(css) && LOADING_SCREEN_HIDDEN_RULE.test(css)
  );
};

export const assertStaticApplicationStylesheetBytes = (
  source,
  label = "application stylesheet",
) => {
  const bytes = toBuffer(source);
  const css = bytes.toString("utf8");
  if (!LOADING_SCREEN_BASE_RULE.test(css)) {
    throw new Error(`${label} does not define the loading-screen base rule`);
  }
  if (!LOADING_SCREEN_HIDDEN_RULE.test(css)) {
    throw new Error(
      `${label} does not statically force #loading-screen.hidden to display:none`,
    );
  }
  return bytes;
};

export const extractStylesheetHrefs = (html) => {
  if (typeof html !== "string") {
    throw new TypeError("Built index HTML must be text");
  }
  return [...html.matchAll(/<link\b[^>]*>/giu)]
    .filter((match) => {
      const rel = readAttribute(match[0], "rel");
      return rel
        ?.split(/\s+/u)
        .some((token) => token.toLowerCase() === "stylesheet");
    })
    .map((match) => readAttribute(match[0], "href"))
    .filter((href) => href !== null);
};

const assertApplicationStylesheetPublicPath = (publicPath) => {
  if (
    !APPLICATION_STYLESHEET_PATH_PATTERN.test(publicPath) ||
    publicPath.includes("//") ||
    publicPath.includes("\\") ||
    publicPath.includes("?") ||
    publicPath.includes("#") ||
    publicPath.split("/").some((segment) => segment === "..")
  ) {
    throw new Error(`Application stylesheet path is invalid: ${publicPath}`);
  }
  return publicPath;
};

export const injectStaticApplicationStylesheetLink = ({ html, cssAssets }) => {
  if (!Array.isArray(cssAssets)) {
    throw new TypeError("CSS asset inventory must be an array");
  }
  const candidates = cssAssets.filter(({ fileName, source }) => {
    if (typeof fileName !== "string" || !fileName.endsWith(".css")) {
      return false;
    }
    return hasStaticApplicationStylesheetContract(source);
  });
  if (candidates.length !== 1) {
    throw new Error(
      `Built output must contain exactly one static application stylesheet; found ${candidates.length}`,
    );
  }
  const candidate = candidates[0];
  const publicPath = assertApplicationStylesheetPublicPath(
    `/${candidate.fileName.replaceAll("\\", "/")}`,
  );
  const hrefs = extractStylesheetHrefs(html);
  if (hrefs.some((href) => href.startsWith("/src/"))) {
    throw new Error("Built index HTML retains a source stylesheet reference");
  }
  const linkedCount = hrefs.filter((href) => href === publicPath).length;
  if (linkedCount > 1) {
    throw new Error("Built index HTML links the application stylesheet twice");
  }
  if (linkedCount === 1) {
    return Object.freeze({ html, publicPath });
  }
  const headClosures = html.match(/<\/head\s*>/giu) ?? [];
  if (headClosures.length !== 1) {
    throw new Error("Built index HTML must contain exactly one head closure");
  }
  return Object.freeze({
    html: html.replace(
      /<\/head\s*>/iu,
      `  <link rel="stylesheet" href="${publicPath}" />\n</head>`,
    ),
    publicPath,
  });
};

export const readStaticApplicationStylesheetContract = async (
  outputRoot,
  { staticDirectory = "static" } = {},
) => {
  if (
    typeof staticDirectory !== "string" ||
    ![".", "static"].includes(staticDirectory)
  ) {
    throw new Error("Static application stylesheet root is invalid");
  }
  const staticRoot = path.join(outputRoot, staticDirectory);
  const indexPath = path.join(staticRoot, "index.html");
  const html = await readFile(indexPath, "utf8");
  const hrefs = extractStylesheetHrefs(html);
  if (hrefs.some((href) => href.startsWith("/src/"))) {
    throw new Error("Built index HTML retains a source stylesheet reference");
  }
  const candidates = [];
  for (const href of hrefs) {
    if (!APPLICATION_STYLESHEET_PATH_PATTERN.test(href)) continue;
    const publicPath = assertApplicationStylesheetPublicPath(href);
    const bytes = await readFile(
      path.join(staticRoot, ...publicPath.slice(1).split("/")),
    );
    if (hasStaticApplicationStylesheetContract(bytes)) {
      candidates.push({ bytes, publicPath });
    }
  }
  if (candidates.length !== 1) {
    throw new Error(
      `Built index HTML must link exactly one static application stylesheet; found ${candidates.length}`,
    );
  }
  const candidate = candidates[0];
  const linkedCount = hrefs.filter(
    (href) => href === candidate.publicPath,
  ).length;
  if (linkedCount !== 1) {
    throw new Error(
      "Built index HTML application stylesheet link is not unique",
    );
  }
  const bytes = assertStaticApplicationStylesheetBytes(
    candidate.bytes,
    candidate.publicPath,
  );
  return Object.freeze({
    bytes,
    html,
    publicPath: candidate.publicPath,
    sha256: sha256Bytes(bytes),
  });
};
