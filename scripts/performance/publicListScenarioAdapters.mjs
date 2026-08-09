import { performance } from "node:perf_hooks";

import {
  buildCanonicalBackup,
  sha256Bytes,
} from "./canonicalPublicFixtures.mjs";

const LIST_PREFERENCE_KEY = "__esp_internal__:list-renderer-preference:v1";
const BACKUP_INPUT_SELECTOR = 'input[aria-label="バックアップファイルを選択"]';
const LIST_ROOT_SELECTOR = '[role="list"][aria-label="買い物リスト"]';
const RECOVERY_HEADING = "保存データを安全に読み込めませんでした";
const MOBILE_VIEWPORT = Object.freeze({ width: 390, height: 844 });
const DESKTOP_VIEWPORT = Object.freeze({ width: 1280, height: 900 });
const MAX_VIRTUAL_DOM_ROWS = 256;
const MIN_FOCUS_SCROLL_MOVEMENT_PX = MOBILE_VIEWPORT.height / 2;
const DEFAULT_TIMEOUT_MS = 120_000;

const preferenceValue = (value) => JSON.stringify({ version: 1, value });

const assertRecord = (value, label) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
};

const assertDataset = (fixtureDocument, scenarioId) => {
  const fixture = assertRecord(fixtureDocument, `${scenarioId} fixture`);
  const dataset = assertRecord(fixture.dataset, `${scenarioId} dataset`);
  if (
    fixture.scenarioId !== scenarioId ||
    dataset.generator !== "shopping-list-seeded-v1" ||
    !Number.isSafeInteger(dataset.seed) ||
    dataset.seed < 0 ||
    !Number.isSafeInteger(dataset.rowCount) ||
    dataset.rowCount < 80 ||
    dataset.grouped !== false
  ) {
    throw new Error(`${scenarioId}: canonical list dataset is invalid`);
  }
  return dataset;
};

const buildExecuteBackup = ({ dataset, eventName, dropFirst = 0 }) => {
  const canonical = buildCanonicalBackup({
    rowCount: dataset.rowCount,
    seed: dataset.seed,
    eventName,
  });
  const document = structuredClone(canonical.document);
  const sourceItems = document.data.eventLists[eventName];
  const items = sourceItems.slice(dropFirst);
  document.data.eventLists[eventName] = items;
  document.data.executeModeItems[eventName] = {
    "1日目": items.map(({ id }) => id),
  };
  document.data.dayModes[eventName] = { "1日目": "execute" };
  const bytes = Buffer.from(JSON.stringify(document), "utf8");
  return Object.freeze({
    bytes,
    document,
    payloadSha256: sha256Bytes(bytes),
    semanticSha256: sha256Bytes(
      Buffer.from(
        JSON.stringify({
          generator: dataset.generator,
          seed: dataset.seed,
          originalRowCount: dataset.rowCount,
          dropFirst,
          eventName,
          mode: "execute",
          itemIds: items.map(({ id }) => id),
        }),
        "utf8",
      ),
    ),
  });
};

export const buildPublicListFixturePayload = (fixtureDocument, scenarioId) => {
  const dataset = assertDataset(fixtureDocument, scenarioId);
  const eventName = `性能計測-${scenarioId}`;
  const initial = buildExecuteBackup({ dataset, eventName });
  const mutationCount =
    scenarioId === "list-virtual-scroll-anchor"
      ? fixtureDocument.operation?.mutateRowsAboveAnchor
      : 0;
  if (
    !Number.isSafeInteger(mutationCount) ||
    mutationCount < 0 ||
    mutationCount >= dataset.rowCount
  ) {
    throw new Error(`${scenarioId}: list mutation count is invalid`);
  }
  const mutation =
    mutationCount === 0
      ? null
      : buildExecuteBackup({ dataset, eventName, dropFirst: mutationCount });
  const payloadSha256 =
    mutation === null
      ? initial.payloadSha256
      : sha256Bytes(
          Buffer.concat([
            initial.bytes,
            Buffer.from("\n--canonical-list-mutation--\n", "utf8"),
            mutation.bytes,
          ]),
        );
  const semanticSha256 = sha256Bytes(
    Buffer.from(
      JSON.stringify({
        scenarioId,
        initial: initial.semanticSha256,
        mutation: mutation?.semanticSha256 ?? null,
      }),
      "utf8",
    ),
  );
  return Object.freeze({
    dataset,
    eventName,
    initial,
    mutation,
    executionBinding: Object.freeze({
      adapterContract: "public-artifact-surface-v1",
      fixturePayload: Object.freeze({
        generator: dataset.generator,
        seed: dataset.seed,
        cardinality: dataset.rowCount,
        payloadSha256,
        semanticSha256,
      }),
      faultInjection: null,
      setup: null,
    }),
  });
};

const waitForPaint = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(resolve),
        );
      }),
  );

const startLongTaskWindow = async (page) => {
  const handle = await page.evaluateHandle(() => {
    if (
      typeof PerformanceObserver !== "function" ||
      !PerformanceObserver.supportedEntryTypes.includes("longtask")
    ) {
      throw new Error("Chromium long-task telemetry is unavailable");
    }
    const durations = [];
    const observer = new PerformanceObserver((entryList) => {
      for (const entry of entryList.getEntries())
        durations.push(entry.duration);
    });
    observer.observe({ type: "longtask", buffered: false });
    return {
      stop() {
        for (const entry of observer.takeRecords())
          durations.push(entry.duration);
        observer.disconnect();
        return durations.length === 0 ? 0 : Math.max(...durations);
      },
    };
  });
  return async () => {
    try {
      const maximum = await handle.evaluate((telemetry) => telemetry.stop());
      if (
        typeof maximum !== "number" ||
        !Number.isFinite(maximum) ||
        maximum < 0
      ) {
        throw new Error("Long-task telemetry returned an invalid duration");
      }
      return maximum;
    } finally {
      await handle.dispose();
    }
  };
};

const setPreference = (page, rawValue) =>
  page.evaluate(
    ({ key, value }) => {
      localStorage.setItem(key, value);
    },
    { key: LIST_PREFERENCE_KEY, value: rawValue },
  );

const assertRecoveryAbsent = async (page, scenarioId) => {
  const count = await page
    .getByRole("heading", { name: RECOVERY_HEADING, exact: true })
    .count();
  if (count !== 0) {
    throw new Error(`${scenarioId}: startup unexpectedly entered recovery`);
  }
};

const openApplication = async (
  { page, scenarioId, targetUrl },
  rawPreference,
) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(targetUrl, { waitUntil: "networkidle" });
  await assertRecoveryAbsent(page, scenarioId);
  await setPreference(page, rawPreference);
};

const stageBackupRestore = async (page, payload, scenarioId) => {
  await page.locator(BACKUP_INPUT_SELECTOR).setInputFiles({
    name: `${scenarioId}.backup.json`,
    mimeType: "application/json",
    buffer: payload.bytes,
  });
  const dialog = page.getByRole("dialog", {
    name: "バックアップからイベントを復元",
    exact: true,
  });
  await dialog.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  await dialog.getByRole("radio", { name: /同名で置換/ }).check();
  return dialog;
};

const canonicalModelRowCount = (itemCount) => itemCount * 2;

const listRootForCount = (page, itemCount) =>
  page.locator(
    `${LIST_ROOT_SELECTOR}[data-list-row-count="${canonicalModelRowCount(itemCount)}"]`,
  );

const waitForListRoot = async (
  page,
  rowCount,
  expectedRenderer,
  scenarioId,
) => {
  const root = listRootForCount(page, rowCount);
  await root.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  if ((await root.count()) !== 1) {
    throw new Error(`${scenarioId}: expected one canonical shopping list`);
  }
  const renderer = await root.getAttribute("data-list-renderer");
  if (renderer !== expectedRenderer) {
    throw new Error(
      `${scenarioId}: expected ${expectedRenderer} renderer; observed ${renderer}`,
    );
  }
  return root;
};

const finishBackupRestore = async ({
  dialog,
  eventName,
  expectedRenderer,
  page,
  rowCount,
  scenarioId,
}) => {
  await dialog
    .getByRole("button", { name: "置換して復元", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT_MS });
  await page
    .getByRole("heading", { name: eventName, exact: true })
    .waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  const root = await waitForListRoot(
    page,
    rowCount,
    expectedRenderer,
    scenarioId,
  );
  await waitForPaint(page);
  return root;
};

const restoreBackup = async ({
  eventName,
  expectedRenderer,
  page,
  payload,
  rowCount,
  scenarioId,
}) => {
  const dialog = await stageBackupRestore(page, payload, scenarioId);
  return finishBackupRestore({
    dialog,
    eventName,
    expectedRenderer,
    page,
    rowCount,
    scenarioId,
  });
};

const restoreBackupMeasured = async (options) => {
  const dialog = await stageBackupRestore(
    options.page,
    options.payload,
    options.scenarioId,
  );
  const stopLongTasks = await startLongTaskWindow(options.page);
  let telemetryStopped = false;
  const startedAt = performance.now();
  try {
    const root = await finishBackupRestore({ ...options, dialog });
    telemetryStopped = true;
    return {
      root,
      durationMs: performance.now() - startedAt,
      maxMainThreadTaskMs: await stopLongTasks(),
    };
  } catch (error) {
    if (!telemetryStopped) await stopLongTasks();
    throw error;
  }
};

const renderedRows = (root) => root.locator('[role="listitem"][data-row-key]');

const expectedAccessibleName = (oneBasedIndex) => {
  const suffix = String(oneBasedIndex).padStart(6, "0");
  const block = `A${String(Math.floor((oneBasedIndex - 1) / 100) + 1).padStart(
    3,
    "0",
  )}`;
  const number = String(((oneBasedIndex - 1) % 100) + 1).padStart(2, "0");
  return `${block}${number} 計測サークル${suffix} 計測頒布物${suffix}`;
};

const expectedCanonicalRowIdentity = (oneBasedIndex) => {
  const suffix = String(oneBasedIndex).padStart(6, "0");
  const block = `A${String(Math.floor((oneBasedIndex - 1) / 100) + 1).padStart(
    3,
    "0",
  )}`;
  const number = String(((oneBasedIndex - 1) % 100) + 1).padStart(2, "0");
  const spaceKey = `${block}-${number}`;
  return Object.freeze({
    groupAccessibleName: `${spaceKey} 1件`,
    groupRowKey: `group:${JSON.stringify(spaceKey)}`,
    itemRowKey: `item:${JSON.stringify(`canonical-item-${suffix}`)}`,
  });
};

const observeList = async ({
  expectedRenderer,
  root,
  rowCount,
  scenarioId,
  sourceIndexOffset = 0,
}) => {
  const stable = await root.getAttribute("data-list-row-keys-stable");
  const observedRowCount = Number(
    await root.getAttribute("data-list-row-count"),
  );
  const reason = await root.getAttribute("data-list-renderer-reason");
  const rows = renderedRows(root);
  const rowContracts = await rows.evaluateAll((elements) =>
    elements.map((element) => ({
      accessibleName: element.getAttribute("aria-label"),
      positionInSet: element.getAttribute("aria-posinset"),
      rowKey: element.getAttribute("data-row-key"),
      setSize: element.getAttribute("aria-setsize"),
    })),
  );
  const domRowCount = rowContracts.length;
  const rowKeys = rowContracts.map(({ rowKey }) => rowKey);
  const itemContracts = rowContracts.filter(
    ({ positionInSet }) => positionInSet !== null,
  );
  const groupContracts = rowContracts.filter(
    ({ positionInSet }) => positionInSet === null,
  );
  const rowPositions = itemContracts.map(({ positionInSet }) =>
    Number(positionInSet),
  );
  const positionsIncrease = rowPositions.every(
    (position, index) => index === 0 || position > rowPositions[index - 1],
  );
  const canonicalItemRows = itemContracts.every((row) => {
    const positionInSet = Number(row.positionInSet);
    const setSize = Number(row.setSize);
    const expectedIdentity = expectedCanonicalRowIdentity(
      sourceIndexOffset + positionInSet,
    );
    return (
      Number.isSafeInteger(positionInSet) &&
      positionInSet >= 1 &&
      positionInSet <= rowCount &&
      setSize === rowCount &&
      row.rowKey === expectedIdentity.itemRowKey &&
      row.accessibleName ===
        expectedAccessibleName(sourceIndexOffset + positionInSet)
    );
  });
  const expectedGroupAccessibleNames = new Map(
    Array.from({ length: rowCount }, (_, index) => {
      const identity = expectedCanonicalRowIdentity(
        sourceIndexOffset + index + 1,
      );
      return [identity.groupRowKey, identity.groupAccessibleName];
    }),
  );
  const canonicalGroupRows = groupContracts.every(
    (row) =>
      typeof row.rowKey === "string" &&
      expectedGroupAccessibleNames.get(row.rowKey) === row.accessibleName &&
      row.setSize === null,
  );
  const expectedModelRowCount = canonicalModelRowCount(rowCount);
  const exactCanonicalSequence = rowContracts.every((row, index) => {
    const positionInSet = Math.floor(index / 2) + 1;
    const expectedIdentity = expectedCanonicalRowIdentity(
      sourceIndexOffset + positionInSet,
    );
    return index % 2 === 0
      ? row.rowKey === expectedIdentity.groupRowKey &&
          row.accessibleName === expectedIdentity.groupAccessibleName &&
          row.positionInSet === null &&
          row.setSize === null
      : row.rowKey === expectedIdentity.itemRowKey &&
          row.accessibleName ===
            expectedAccessibleName(sourceIndexOffset + positionInSet) &&
          row.positionInSet === String(positionInSet) &&
          row.setSize === String(rowCount);
  });
  const exactFullModel =
    expectedRenderer !== "full" ||
    (domRowCount === expectedModelRowCount &&
      itemContracts.length === rowCount &&
      groupContracts.length === rowCount &&
      exactCanonicalSequence);
  const boundedDomWindow =
    expectedRenderer !== "virtual" ||
    (domRowCount < expectedModelRowCount &&
      domRowCount <= MAX_VIRTUAL_DOM_ROWS);
  if (
    stable !== "true" ||
    observedRowCount !== expectedModelRowCount ||
    reason === null ||
    reason.length === 0 ||
    domRowCount < 1 ||
    itemContracts.length < 1 ||
    !canonicalItemRows ||
    !canonicalGroupRows ||
    !positionsIncrease ||
    new Set(rowKeys).size !== rowKeys.length ||
    !exactFullModel ||
    !boundedDomWindow
  ) {
    throw new Error(`${scenarioId}: canonical list DOM contract failed`);
  }
  return Object.freeze({
    accessibleNameParity: canonicalItemRows,
    boundedDomWindow,
    canonicalRowModel:
      stable === "true" &&
      observedRowCount === expectedModelRowCount &&
      exactFullModel &&
      canonicalGroupRows &&
      positionsIncrease &&
      new Set(rowKeys).size === rowKeys.length,
    domRowCount,
    reason,
  });
};

const exactMetrics = (requiredTelemetry, available, scenarioId) =>
  Object.fromEntries(
    requiredTelemetry.map((metric) => {
      const value = available[metric];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${scenarioId}: telemetry ${metric} is unavailable`);
      }
      return [metric, value];
    }),
  );

const exactAssertions = (requiredAssertions, available, scenarioId) =>
  Object.fromEntries(
    requiredAssertions.map((assertion) => {
      if (available[assertion] !== true) {
        throw new Error(`${scenarioId}: assertion ${assertion} did not pass`);
      }
      return [assertion, true];
    }),
  );

const makeResult = (options, payload, metrics, assertions) => ({
  metrics: exactMetrics(options.requiredTelemetry, metrics, options.scenarioId),
  assertions: exactAssertions(
    options.requiredAssertions,
    assertions,
    options.scenarioId,
  ),
  executionBinding: payload.executionBinding,
});

const runInitialRender = async (options, expectedRenderer) => {
  const payload = buildPublicListFixturePayload(
    options.fixtureDocument,
    options.scenarioId,
  );
  const preference = expectedRenderer === "full" ? "full" : "auto";
  await openApplication(options, preferenceValue(preference));
  const measured = await restoreBackupMeasured({
    eventName: payload.eventName,
    expectedRenderer,
    page: options.page,
    payload: payload.initial,
    rowCount: payload.dataset.rowCount,
    scenarioId: options.scenarioId,
  });
  const observation = await observeList({
    expectedRenderer,
    root: measured.root,
    rowCount: payload.dataset.rowCount,
    scenarioId: options.scenarioId,
  });
  const expectedReason =
    expectedRenderer === "full" ? "preference-full" : "virtual-eligible";
  const selectedExpectedRenderer = observation.reason === expectedReason;
  return makeResult(
    options,
    payload,
    {
      durationMs: measured.durationMs,
      maxMainThreadTaskMs: measured.maxMainThreadTaskMs,
      renderedDomRowCount: observation.domRowCount,
    },
    expectedRenderer === "full"
      ? {
          "selected-renderer-full": selectedExpectedRenderer,
          "canonical-row-model": observation.canonicalRowModel,
          "accessible-name-parity": observation.accessibleNameParity,
        }
      : {
          "eligible-state-proven":
            observation.reason === "virtual-eligible" &&
            observation.boundedDomWindow,
          "selected-renderer-virtual": selectedExpectedRenderer,
          "canonical-row-model": observation.canonicalRowModel,
          "accessible-name-parity": observation.accessibleNameParity,
          "bounded-dom-window": observation.boundedDomWindow,
        },
  );
};

const scrollVirtualToIndex = async (page, root, targetIndex, rowCount) => {
  const beforeScrollY = await page.evaluate(() => globalThis.scrollY);
  await root.evaluate(
    (element, input) => {
      const canvas = element.querySelector("[data-layout-height]");
      const totalHeight = Number.parseFloat(
        canvas?.getAttribute("data-layout-height") ?? "",
      );
      if (!Number.isFinite(totalHeight) || totalHeight <= 0) {
        throw new Error("Virtual list does not expose a finite layout height");
      }
      const rootTop = element.getBoundingClientRect().top + globalThis.scrollY;
      globalThis.scrollTo({
        behavior: "instant",
        top: rootTop + (totalHeight * input.targetIndex) / input.rowCount,
      });
    },
    { targetIndex, rowCount },
  );
  const row = page.getByRole("listitem", {
    name: expectedAccessibleName(targetIndex + 1),
    exact: true,
  });
  await row.waitFor({ state: "attached", timeout: DEFAULT_TIMEOUT_MS });
  await waitForPaint(page);
  const [afterScroll, position] = await Promise.all([
    page.evaluate(() => ({
      height: globalThis.innerHeight,
      scrollY: globalThis.scrollY,
    })),
    observeRowPosition(row),
  ]);
  if (
    !Number.isFinite(beforeScrollY) ||
    !Number.isFinite(afterScroll.scrollY) ||
    afterScroll.scrollY - beforeScrollY < MIN_FOCUS_SCROLL_MOVEMENT_PX ||
    !Number.isFinite(position.top) ||
    !Number.isFinite(position.bottom) ||
    position.bottom <= 0 ||
    position.top >= afterScroll.height
  ) {
    throw new Error("Virtual list did not move the target row into view");
  }
  return { position, row, scrollY: afterScroll.scrollY };
};

const observeRowPosition = (row) =>
  row.evaluate((element) => ({
    bottom: element.getBoundingClientRect().bottom,
    rowKey: element.getAttribute("data-row-key"),
    top: element.getBoundingClientRect().top,
  }));

const runScrollAnchor = async (options) => {
  const payload = buildPublicListFixturePayload(
    options.fixtureDocument,
    options.scenarioId,
  );
  if (!payload.mutation) {
    throw new Error(`${options.scenarioId}: mutation payload is absent`);
  }
  const targetIndex = options.fixtureDocument.operation?.targetRowIndex;
  const mutationCount =
    options.fixtureDocument.operation?.mutateRowsAboveAnchor;
  if (
    !Number.isSafeInteger(targetIndex) ||
    targetIndex < mutationCount ||
    targetIndex >= payload.dataset.rowCount
  ) {
    throw new Error(
      `${options.scenarioId}: scroll anchor operation is invalid`,
    );
  }
  await openApplication(options, preferenceValue("auto"));
  const initialRoot = await restoreBackup({
    eventName: payload.eventName,
    expectedRenderer: "virtual",
    page: options.page,
    payload: payload.initial,
    rowCount: payload.dataset.rowCount,
    scenarioId: options.scenarioId,
  });
  const { position: before } = await scrollVirtualToIndex(
    options.page,
    initialRoot,
    targetIndex,
    payload.dataset.rowCount,
  );
  if (!before.rowKey || !Number.isFinite(before.top)) {
    throw new Error(`${options.scenarioId}: anchor row is not observable`);
  }

  const dialog = await stageBackupRestore(
    options.page,
    payload.mutation,
    options.scenarioId,
  );
  const stopLongTasks = await startLongTaskWindow(options.page);
  let telemetryStopped = false;
  const startedAt = performance.now();
  let root;
  let maximum;
  try {
    root = await finishBackupRestore({
      dialog,
      eventName: payload.eventName,
      expectedRenderer: "virtual",
      page: options.page,
      rowCount: payload.dataset.rowCount - mutationCount,
      scenarioId: options.scenarioId,
    });
    telemetryStopped = true;
    maximum = await stopLongTasks();
  } catch (error) {
    if (!telemetryStopped) await stopLongTasks();
    throw error;
  }
  const durationMs = performance.now() - startedAt;
  const restoredRow = options.page.getByRole("listitem", {
    name: expectedAccessibleName(targetIndex + 1),
    exact: true,
  });
  await restoredRow.waitFor({ state: "attached", timeout: DEFAULT_TIMEOUT_MS });
  const after = await observeRowPosition(restoredRow);
  const drift = Math.abs(after.top - before.top);
  const observation = await observeList({
    expectedRenderer: "virtual",
    root,
    rowCount: payload.dataset.rowCount - mutationCount,
    scenarioId: options.scenarioId,
    sourceIndexOffset: mutationCount,
  });
  const stableAnchor = after.rowKey === before.rowKey;
  const anchorRestored =
    stableAnchor &&
    Number.isFinite(after.top) &&
    Number.isFinite(after.bottom) &&
    Number.isFinite(drift);
  if (!anchorRestored) {
    throw new Error(`${options.scenarioId}: stable anchor was not restored`);
  }
  return makeResult(
    options,
    payload,
    {
      durationMs,
      maxMainThreadTaskMs: maximum,
      scrollAnchorDriftPx: drift,
    },
    {
      "selected-renderer-virtual": observation.reason === "virtual-eligible",
      "stable-row-key-anchor": stableAnchor,
      "anchor-restored": anchorRestored,
      "bounded-dom-window": observation.boundedDomWindow,
    },
  );
};

const focusableWithin = (row) =>
  row
    .locator(
      'input:not([disabled]),button:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])',
    )
    .first();

const runFocusInteraction = async (options) => {
  const payload = buildPublicListFixturePayload(
    options.fixtureDocument,
    options.scenarioId,
  );
  const targetIndex = options.fixtureDocument.operation?.targetRowIndex;
  const iterationCount = options.fixtureDocument.operation?.iterationCount;
  if (
    !Number.isSafeInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex >= payload.dataset.rowCount ||
    !Number.isSafeInteger(iterationCount) ||
    iterationCount < 1
  ) {
    throw new Error(`${options.scenarioId}: focus operation is invalid`);
  }
  await openApplication(options, preferenceValue("auto"));
  const root = await restoreBackup({
    eventName: payload.eventName,
    expectedRenderer: "virtual",
    page: options.page,
    payload: payload.initial,
    rowCount: payload.dataset.rowCount,
    scenarioId: options.scenarioId,
  });
  const initialScroll = await scrollVirtualToIndex(
    options.page,
    root,
    targetIndex,
    payload.dataset.rowCount,
  );
  const { row } = initialScroll;
  const rowKey = await row.getAttribute("data-row-key");
  if (!rowKey)
    throw new Error(`${options.scenarioId}: focus row key is absent`);
  await focusableWithin(row).focus();
  const stopLongTasks = await startLongTaskWindow(options.page);
  let telemetryStopped = false;
  const startedAt = performance.now();
  let failureCount = 0;
  let previousScrollY = initialScroll.scrollY;
  try {
    for (let iteration = 0; iteration < iterationCount; iteration += 1) {
      const scrollToTarget = iteration % 2 !== 0;
      await options.page.keyboard.press("Space");
      await options.page.evaluate(
        ({ rowCount, scrollToTarget, targetIndex: index }) => {
          const rootElement = globalThis.document.querySelector(
            '[role="list"][aria-label="買い物リスト"][data-list-renderer="virtual"]',
          );
          const canvas = rootElement?.querySelector("[data-layout-height]");
          const totalHeight = Number.parseFloat(
            canvas?.getAttribute("data-layout-height") ?? "",
          );
          const rootTop =
            (rootElement?.getBoundingClientRect().top ?? 0) +
            globalThis.scrollY;
          globalThis.scrollTo({
            behavior: "instant",
            top: scrollToTarget
              ? rootTop + (totalHeight * index) / rowCount
              : 0,
          });
        },
        {
          scrollToTarget,
          targetIndex,
          rowCount: payload.dataset.rowCount,
        },
      );
      await waitForPaint(options.page);
      const focusedKey = await root.getAttribute("data-list-focused-row-key");
      const [activeRowKey, currentScrollY, currentPosition] = await Promise.all(
        [
          options.page.evaluate(() =>
            globalThis.document.activeElement
              ?.closest?.("[data-row-key]")
              ?.getAttribute("data-row-key"),
          ),
          options.page.evaluate(() => globalThis.scrollY),
          observeRowPosition(row),
        ],
      );
      const moved =
        Number.isFinite(currentScrollY) &&
        Math.abs(currentScrollY - previousScrollY) >=
          MIN_FOCUS_SCROLL_MOVEMENT_PX;
      const positionMatchesRequest = scrollToTarget
        ? currentPosition.bottom > 0 &&
          currentPosition.top < MOBILE_VIEWPORT.height
        : currentPosition.top >= MOBILE_VIEWPORT.height;
      if (
        focusedKey !== rowKey ||
        activeRowKey !== rowKey ||
        !moved ||
        !positionMatchesRequest
      ) {
        failureCount += 1;
      }
      previousScrollY = currentScrollY;
    }
    const durationMs = performance.now() - startedAt;
    telemetryStopped = true;
    const maximum = await stopLongTasks();
    const observation = await observeList({
      expectedRenderer: "virtual",
      root,
      rowCount: payload.dataset.rowCount,
      scenarioId: options.scenarioId,
    });
    return makeResult(
      options,
      payload,
      {
        durationMs,
        maxMainThreadTaskMs: maximum,
        focusRestoreFailureCount: failureCount,
      },
      {
        "selected-renderer-virtual": observation.reason === "virtual-eligible",
        "focused-row-pinned": failureCount === 0,
        "focus-restored-by-row-key": failureCount === 0,
        "accessible-name-parity": observation.accessibleNameParity,
      },
    );
  } catch (error) {
    if (!telemetryStopped) await stopLongTasks();
    throw error;
  }
};

const waitForRenderer = (page, rowCount, renderer, scenarioId) =>
  waitForListRoot(page, rowCount, renderer, scenarioId);

const reopenPersistedEvent = async (page, eventName) => {
  await page
    .getByText(eventName, { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  await page.getByText(eventName, { exact: true }).first().click();
  await page
    .getByRole("heading", { name: eventName, exact: true })
    .waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
};

const enterUnsupportedDatabaseRecovery = async (page) => {
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open("EventShoppingPlannerDB", 8);
        request.onerror = () => reject(request.error);
        request.onblocked = () =>
          reject(new Error("IndexedDB upgrade blocked"));
        request.onsuccess = () => {
          request.result.close();
          resolve(undefined);
        };
      }),
  );
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByRole("heading", { name: RECOVERY_HEADING, exact: true })
    .waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
};

const runRendererSelection = async (options) => {
  const payload = buildPublicListFixturePayload(
    options.fixtureDocument,
    options.scenarioId,
  );
  const rowCount = payload.dataset.rowCount;
  let mismatchCount = 0;
  const observedCases = [];
  const observeExpected = async (renderer) => {
    try {
      return await waitForRenderer(
        options.page,
        rowCount,
        renderer,
        options.scenarioId,
      );
    } catch (error) {
      mismatchCount += 1;
      throw error;
    }
  };
  const observeReason = async (caseName, currentRoot, expectedReason) => {
    const reason = await currentRoot.getAttribute("data-list-renderer-reason");
    const matches = reason === expectedReason;
    observedCases.push({ caseName, expectedReason, matches, reason });
    if (!matches) mismatchCount += 1;
    return reason;
  };

  await openApplication(options, preferenceValue("auto"));
  let root = await restoreBackup({
    eventName: payload.eventName,
    expectedRenderer: "virtual",
    page: options.page,
    payload: payload.initial,
    rowCount,
    scenarioId: options.scenarioId,
  });
  const startedAt = performance.now();
  try {
    await observeReason("eligible-single-column", root, "virtual-eligible");

    const dataTransfer = await options.page.evaluateHandle(
      () => new globalThis.DataTransfer(),
    );
    try {
      await root
        .locator("[data-item-id]")
        .first()
        .dispatchEvent("dragstart", { dataTransfer });
      root = await observeExpected("full");
      await observeReason("drag-active", root, "virtual-ineligible");
      await root
        .locator("[data-item-id]")
        .first()
        .dispatchEvent("dragend", { dataTransfer });
    } finally {
      await dataTransfer.dispose();
    }
    root = await observeExpected("virtual");
    await observeReason("drag-cleared", root, "virtual-eligible");

    await options.page.setViewportSize(DESKTOP_VIEWPORT);
    await options.page.getByTitle("タブレット/PCモードに切替").click();
    root = await observeExpected("full");
    await observeReason("multiple-columns", root, "virtual-ineligible");
    await options.page.getByTitle("スマートフォンモードに切替").click();
    await options.page.setViewportSize(MOBILE_VIEWPORT);
    root = await observeExpected("virtual");
    await observeReason("single-column-restored", root, "virtual-eligible");

    const settingsButton = options.page.getByTitle("表示項目の設定");
    await settingsButton.click();
    const zoom = options.page.getByLabel("画面の表示倍率", { exact: true });
    await zoom.selectOption("125");
    root = await observeExpected("full");
    await observeReason("unsupported-zoom", root, "virtual-ineligible");
    await zoom.selectOption("100");
    root = await observeExpected("virtual");
    await observeReason("supported-zoom-restored", root, "virtual-eligible");
    await settingsButton.click();

    let statusButton = root
      .getByRole("button", { name: /Current status: 未購入/ })
      .first();
    await statusButton.click();
    statusButton = root
      .getByRole("button", { name: /Current status: 購入済/ })
      .first();
    await statusButton.waitFor({
      state: "visible",
      timeout: DEFAULT_TIMEOUT_MS,
    });
    await statusButton.click();
    const distributionDialog = options.page.getByRole("dialog", {
      name: "事後通販･頒布可否確認",
      exact: true,
    });
    await distributionDialog.waitFor({
      state: "visible",
      timeout: DEFAULT_TIMEOUT_MS,
    });
    root = await observeExpected("full");
    await observeReason("modal-active", root, "virtual-ineligible");
    await distributionDialog
      .getByRole("button", { name: "キャンセル", exact: true })
      .click();
    root = await observeExpected("virtual");
    await observeReason("modal-cleared", root, "virtual-eligible");

    await setPreference(options.page, "{corrupt-list-preference");
    await options.page.reload({ waitUntil: "networkidle" });
    await reopenPersistedEvent(options.page, payload.eventName);
    root = await observeExpected("full");
    const corruptReason = await root.getAttribute("data-list-renderer-reason");
    const corruptMatches = corruptReason === "preference-full";
    observedCases.push({
      caseName: "corrupt-preference",
      expectedReason: "preference-full",
      matches: corruptMatches,
      reason: corruptReason,
    });
    if (!corruptMatches) {
      mismatchCount += 1;
      throw new Error(
        `${options.scenarioId}: corrupt preference did not fail full`,
      );
    }

    await enterUnsupportedDatabaseRecovery(options.page);
    if ((await options.page.locator(LIST_ROOT_SELECTOR).count()) !== 0) {
      mismatchCount += 1;
      throw new Error(`${options.scenarioId}: recovery retained a list graph`);
    }
    const durationMs = performance.now() - startedAt;
    const allReasonsExposed = observedCases.every(
      ({ reason }) => typeof reason === "string" && reason.length > 0,
    );
    const dragCase = observedCases.find(
      ({ caseName }) => caseName === "drag-active",
    );
    return makeResult(
      options,
      payload,
      { durationMs, rendererMismatchCount: mismatchCount },
      {
        "all-eligibility-cases-match":
          mismatchCount === 0 && observedCases.every(({ matches }) => matches),
        "unknown-state-selects-full": corruptMatches,
        "drag-selects-full-before-reorder": dragCase?.matches === true,
        "selection-reason-exposed": allReasonsExposed,
        "recovery-disables-list-graph": true,
      },
    );
  } catch (error) {
    throw new Error(`${options.scenarioId}: eligibility matrix failed`, {
      cause: error,
    });
  }
};

const checkedAdapter = (scenarioId, implementation) => async (options) => {
  if (options.scenarioId !== scenarioId) {
    throw new Error(
      `Public list adapter expected ${scenarioId}; received ${options.scenarioId}`,
    );
  }
  return implementation(options);
};

export const publicListScenarioAdapters = Object.freeze({
  "list-long-full": checkedAdapter("list-long-full", (options) =>
    runInitialRender(options, "full"),
  ),
  "list-long-virtual": checkedAdapter("list-long-virtual", (options) =>
    runInitialRender(options, "virtual"),
  ),
  "list-virtual-scroll-anchor": checkedAdapter(
    "list-virtual-scroll-anchor",
    runScrollAnchor,
  ),
  "list-virtual-focus-interaction": checkedAdapter(
    "list-virtual-focus-interaction",
    runFocusInteraction,
  ),
  "list-renderer-selection": checkedAdapter(
    "list-renderer-selection",
    runRendererSelection,
  ),
});
