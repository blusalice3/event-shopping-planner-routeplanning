import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  buildPublicListFixturePayload,
  publicListScenarioAdapters,
} from "./publicListScenarioAdapters.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");

const loadFixture = async (name) =>
  JSON.parse(
    await readFile(
      path.resolve(root, "scripts", "fixtures", "performance", name),
      "utf8",
    ),
  );

class FakeHandle {
  constructor(value) {
    this.value = value;
    this.disposed = false;
  }

  async evaluate(callback) {
    assert.equal(this.disposed, false);
    return callback(this.value);
  }

  async dispose() {
    this.disposed = true;
  }
}

class FakeLocator {
  constructor(page, kind, options = {}) {
    this.page = page;
    this.kind = kind;
    this.options = options;
  }

  first() {
    return new FakeLocator(this.page, this.kind, {
      ...this.options,
      first: true,
    });
  }

  locator(selector) {
    if (this.kind === "list-root" && selector.includes("listitem")) {
      return new FakeLocator(this.page, "rows");
    }
    throw new Error(`Unexpected nested fake locator: ${this.kind} ${selector}`);
  }

  getByRole(role, options) {
    if (this.kind !== "restore-dialog") {
      throw new Error(`Unexpected fake role scope: ${this.kind}`);
    }
    return new FakeLocator(this.page, `${role}:${String(options.name)}`);
  }

  async setInputFiles(file) {
    assert.equal(this.kind, "backup-input");
    assert.equal(file.mimeType, "application/json");
    const backup = JSON.parse(file.buffer.toString("utf8"));
    const [eventName] = Object.keys(backup.data.eventLists);
    const items = backup.data.eventLists[eventName];
    assert.equal(backup.data.dayModes[eventName]["1日目"], "execute");
    assert.deepEqual(
      backup.data.executeModeItems[eventName]["1日目"],
      items.map(({ id }) => id),
    );
    this.page.stagedBackup = backup;
    this.page.dialogVisible = true;
  }

  async check() {
    assert.match(this.kind, /^radio:/);
    this.page.replaceChecked = true;
  }

  async click() {
    if (this.kind === "button:置換して復元") {
      assert.equal(this.page.replaceChecked, true);
      this.page.dialogVisible = false;
      this.page.restored = true;
      return;
    }
    throw new Error(`Unexpected fake click: ${this.kind}`);
  }

  async waitFor({ state }) {
    if (this.kind === "restore-dialog") {
      assert.equal(this.page.dialogVisible, state === "visible");
    }
    if (this.kind === "list-root") assert.equal(this.page.restored, true);
  }

  async count() {
    if (this.kind === "recovery-heading") return 0;
    if (this.kind === "list-root") return this.page.restored ? 1 : 0;
    if (this.kind === "rows") {
      return this.page.renderer === "full" ? this.page.rowCount * 2 : 24;
    }
    return 1;
  }

  async evaluateAll(callback) {
    assert.equal(this.kind, "rows");
    const count = this.page.renderer === "full" ? this.page.rowCount * 2 : 24;
    const elements = Array.from({ length: count }, (_, index) => {
      const canonicalIndex =
        this.page.renderer === "full" && this.page.swapFirstFullPair
          ? index === 0
            ? 1
            : index === 1
              ? 0
              : index
          : index;
      const isGroup = canonicalIndex % 2 === 0;
      const position = Math.floor(canonicalIndex / 2) + 1;
      const suffix = String(position).padStart(6, "0");
      const block = `A${String(Math.floor((position - 1) / 100) + 1).padStart(3, "0")}`;
      const number = String(((position - 1) % 100) + 1).padStart(2, "0");
      const spaceKey = `${block}-${number}`;
      return {
        getAttribute: (name) => {
          if (name === "aria-label") {
            if (isGroup) return `${spaceKey} 1件`;
            return position === this.page.corruptAccessiblePosition
              ? "破損したアクセシブル名"
              : `${block}${number} 計測サークル${suffix} 計測頒布物${suffix}`;
          }
          if (name === "aria-posinset")
            return isGroup ? null : String(position);
          if (name === "aria-setsize")
            return isGroup ? null : String(this.page.rowCount);
          if (name === "data-row-key") {
            return isGroup
              ? `group:${JSON.stringify(spaceKey)}`
              : `item:"canonical-item-${suffix}"`;
          }
          return null;
        },
      };
    });
    return callback(elements);
  }

  async getAttribute(name) {
    if (this.kind === "list-root") {
      return {
        "data-list-renderer": this.page.renderer,
        "data-list-renderer-reason":
          this.page.forcedReason ??
          (this.page.renderer === "full"
            ? "preference-full"
            : "virtual-eligible"),
        "data-list-row-count": String(this.page.rowCount * 2),
        "data-list-row-keys-stable": "true",
      }[name];
    }
    if (this.kind === "rows" && name === "aria-label") {
      return "A00101 計測サークル000001 計測頒布物000001";
    }
    if (this.kind === "rows" && name === "aria-posinset") return "1";
    return null;
  }
}

class FakePage {
  constructor(rowCount) {
    this.rowCount = rowCount;
    this.renderer = "virtual";
    this.dialogVisible = false;
    this.replaceChecked = false;
    this.restored = false;
    this.stagedBackup = null;
    this.viewport = null;
    this.targetUrl = null;
    this.corruptAccessiblePosition = null;
    this.forcedReason = null;
    this.swapFirstFullPair = false;
  }

  async setViewportSize(viewport) {
    this.viewport = viewport;
  }

  async goto(targetUrl) {
    this.targetUrl = targetUrl;
  }

  async evaluate(_callback, argument) {
    if (argument?.key === "__esp_internal__:list-renderer-preference:v1") {
      const preference = JSON.parse(argument.value);
      this.renderer = preference.value === "full" ? "full" : "virtual";
    }
  }

  async evaluateHandle() {
    return new FakeHandle({ stop: () => 7.5 });
  }

  locator(selector) {
    if (selector.includes("バックアップファイルを選択")) {
      return new FakeLocator(this, "backup-input");
    }
    if (selector.includes('role="list"')) {
      return new FakeLocator(this, "list-root");
    }
    throw new Error(`Unexpected fake selector: ${selector}`);
  }

  getByRole(role, options) {
    if (
      role === "heading" &&
      options.name === "保存データを安全に読み込めませんでした"
    ) {
      return new FakeLocator(this, "recovery-heading");
    }
    if (role === "dialog") return new FakeLocator(this, "restore-dialog");
    if (role === "heading") return new FakeLocator(this, "event-heading");
    throw new Error(`Unexpected fake role: ${role}`);
  }
}

test("builds deterministic execute-mode backup bindings including anchor mutation", async () => {
  const fixture = await loadFixture("list-virtual-scroll-anchor.json");
  const first = buildPublicListFixturePayload(
    fixture,
    "list-virtual-scroll-anchor",
  );
  const second = buildPublicListFixturePayload(
    fixture,
    "list-virtual-scroll-anchor",
  );
  assert.deepEqual(first.executionBinding, second.executionBinding);
  assert.equal(first.executionBinding.setup, null);
  assert.equal(
    first.initial.document.data.eventLists[first.eventName].length,
    10_000,
  );
  assert.equal(
    first.mutation.document.data.eventLists[first.eventName].length,
    9_975,
  );
  assert.notEqual(first.initial.payloadSha256, first.mutation.payloadSha256);
  assert.match(
    first.executionBinding.fixturePayload.semanticSha256,
    /^[0-9a-f]{64}$/,
  );
});

for (const [fixtureName, scenarioId, expectedRenderer] of [
  ["list-long-full.json", "list-long-full", "full"],
  ["list-long-virtual.json", "list-long-virtual", "virtual"],
]) {
  test(`${scenarioId} drives the public backup and DOM contract`, async () => {
    const fixture = await loadFixture(fixtureName);
    const page = new FakePage(fixture.dataset.rowCount);
    const result = await publicListScenarioAdapters[scenarioId]({
      fixtureDocument: fixture,
      page,
      requiredAssertions: fixture.requiredAssertions,
      requiredTelemetry: fixture.requiredTelemetry,
      scenarioId,
      targetUrl: "https://immutable.example.test/",
    });
    assert.deepEqual(Object.keys(result), [
      "metrics",
      "assertions",
      "executionBinding",
    ]);
    assert.equal(result.metrics.maxMainThreadTaskMs, 7.5);
    assert.equal(
      result.metrics.renderedDomRowCount,
      expectedRenderer === "full" ? 20_000 : 24,
    );
    assert.equal(Object.values(result.assertions).every(Boolean), true);
    assert.equal(page.renderer, expectedRenderer);
    assert.equal(page.targetUrl, "https://immutable.example.test/");
    assert.deepEqual(page.viewport, { width: 390, height: 844 });
    assert.equal(
      page.stagedBackup.data.dayModes[`性能計測-${scenarioId}`]["1日目"],
      "execute",
    );
  });
}

test("rejects cross-scenario dispatch before touching the page", async () => {
  await assert.rejects(
    publicListScenarioAdapters["list-long-full"]({
      scenarioId: "list-long-virtual",
    }),
    /expected list-long-full/,
  );
});

test("fails closed when the selected renderer reason is not the exact eligibility reason", async () => {
  const fixture = await loadFixture("list-long-virtual.json");
  const page = new FakePage(fixture.dataset.rowCount);
  page.forcedReason = "virtual-ineligible";
  await assert.rejects(
    publicListScenarioAdapters["list-long-virtual"]({
      fixtureDocument: fixture,
      page,
      requiredAssertions: fixture.requiredAssertions,
      requiredTelemetry: fixture.requiredTelemetry,
      scenarioId: "list-long-virtual",
      targetUrl: "https://immutable.example.test/",
    }),
    /eligible-state-proven/,
  );
});

test("checks every rendered row in the accessible-name parity window", async () => {
  const fixture = await loadFixture("list-long-virtual.json");
  const page = new FakePage(fixture.dataset.rowCount);
  page.corruptAccessiblePosition = 12;
  await assert.rejects(
    publicListScenarioAdapters["list-long-virtual"]({
      fixtureDocument: fixture,
      page,
      requiredAssertions: fixture.requiredAssertions,
      requiredTelemetry: fixture.requiredTelemetry,
      scenarioId: "list-long-virtual",
      targetUrl: "https://immutable.example.test/",
    }),
    /canonical list DOM contract/,
  );
});

test("fails closed when the full renderer does not preserve canonical group/item order", async () => {
  const fixture = await loadFixture("list-long-full.json");
  const page = new FakePage(fixture.dataset.rowCount);
  page.swapFirstFullPair = true;
  await assert.rejects(
    publicListScenarioAdapters["list-long-full"]({
      fixtureDocument: fixture,
      page,
      requiredAssertions: fixture.requiredAssertions,
      requiredTelemetry: fixture.requiredTelemetry,
      scenarioId: "list-long-full",
      targetUrl: "https://immutable.example.test/",
    }),
    /canonical list DOM contract/,
  );
});

test("exports exactly the five Phase 5 public list scenarios", () => {
  assert.deepEqual(Object.keys(publicListScenarioAdapters), [
    "list-long-full",
    "list-long-virtual",
    "list-virtual-scroll-anchor",
    "list-virtual-focus-interaction",
    "list-renderer-selection",
  ]);
});
