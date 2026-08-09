import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertStaticApplicationStylesheetBytes,
  injectStaticApplicationStylesheetLink,
  readStaticApplicationStylesheetContract,
} from "./application-stylesheet-contract.mjs";

const applicationCss = Buffer.from(
  "#loading-screen{display:flex;position:fixed}#loading-screen.hidden{display:none;visibility:hidden}",
  "utf8",
);
const html = "<!doctype html><html><head></head><body></body></html>";
const cssAsset = {
  fileName: "assets/app-contract.css",
  source: applicationCss,
};

test("injects the exact static application stylesheet once", () => {
  const injected = injectStaticApplicationStylesheetLink({
    html,
    cssAssets: [cssAsset],
  });
  assert.equal(injected.publicPath, "/assets/app-contract.css");
  assert.equal(
    injected.html.match(/<link\b[^>]*rel="stylesheet"[^>]*>/gu)?.length,
    1,
  );
  assert.deepEqual(
    injectStaticApplicationStylesheetLink({
      html: injected.html,
      cssAssets: [cssAsset],
    }),
    injected,
  );
});

test("rejects missing, ambiguous, source, and duplicate stylesheet bindings", () => {
  assert.throws(
    () => injectStaticApplicationStylesheetLink({ html, cssAssets: [] }),
    /exactly one static application stylesheet; found 0/u,
  );
  assert.throws(
    () =>
      injectStaticApplicationStylesheetLink({
        html,
        cssAssets: [
          cssAsset,
          { fileName: "assets/other.css", source: applicationCss },
        ],
      }),
    /found 2/u,
  );
  assert.throws(
    () =>
      injectStaticApplicationStylesheetLink({
        html: html.replace(
          "</head>",
          '<link rel="stylesheet" href="/src/styles/application.css" /></head>',
        ),
        cssAssets: [cssAsset],
      }),
    /source stylesheet reference/u,
  );
  const duplicate = html.replace(
    "</head>",
    '<link rel="stylesheet" href="/assets/app-contract.css" /><link href="/assets/app-contract.css" rel="stylesheet" /></head>',
  );
  assert.throws(
    () =>
      injectStaticApplicationStylesheetLink({
        html: duplicate,
        cssAssets: [cssAsset],
      }),
    /links the application stylesheet twice/u,
  );
});

test("requires ID-specific static display suppression", () => {
  assert.throws(
    () =>
      assertStaticApplicationStylesheetBytes(
        "#loading-screen{display:flex}.hidden{display:none}",
      ),
    /#loading-screen\.hidden/u,
  );
});

test("re-reads the built index and linked stylesheet bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "app-css-contract-"));
  try {
    await mkdir(path.join(root, "static", "assets"), { recursive: true });
    const linkedHtml = injectStaticApplicationStylesheetLink({
      html,
      cssAssets: [cssAsset],
    }).html;
    await Promise.all([
      writeFile(path.join(root, "static", "index.html"), linkedHtml),
      writeFile(
        path.join(root, "static", "assets", "app-contract.css"),
        applicationCss,
      ),
    ]);
    const contract = await readStaticApplicationStylesheetContract(root);
    assert.equal(contract.publicPath, "/assets/app-contract.css");
    assert.match(contract.sha256, /^[0-9a-f]{64}$/u);

    await writeFile(
      path.join(root, "static", "assets", "app-contract.css"),
      "#loading-screen{display:flex}#loading-screen.hidden{visibility:hidden}",
    );
    await assert.rejects(
      readStaticApplicationStylesheetContract(root),
      /must link exactly one static application stylesheet; found 0/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
