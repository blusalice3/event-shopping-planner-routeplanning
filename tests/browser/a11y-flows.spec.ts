import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";

const EVENT_NAME = "アクセシビリティ検証イベント";
const EVENT_DATE = "1日目";
const MAP_NAME = "1日目マップ";

const noBorders = {
  top: null,
  right: null,
  bottom: null,
  left: null,
} as const;

const representativeBackup = {
  kind: "event-shopping-planner-backup",
  version: 1,
  exportedAt: "2026-08-08T00:00:00.000Z",
  eventSettings: {
    blockDetectionSettings: {},
  },
  data: {
    eventLists: {
      [EVENT_NAME]: [
        {
          id: "item-highest",
          circle: "サークル最優先",
          eventDate: EVENT_DATE,
          block: "東A",
          number: "01a",
          title: "新刊セット",
          price: 1_000,
          purchaseStatus: "None",
          quantity: 1,
          remarks: "ユーザー登録",
          priorityLevel: "highest",
          manualHallId: "hall-east",
        },
        {
          id: "item-priority",
          circle: "サークル優先",
          eventDate: EVENT_DATE,
          block: "東A",
          number: "02b",
          title: "既刊セット",
          price: 500,
          purchaseStatus: "Postpone",
          quantity: 1,
          remarks: "後回し候補",
          priorityLevel: "priority",
          manualHallId: "hall-east",
        },
        {
          id: "item-late",
          circle: "サークル遅参",
          eventDate: EVENT_DATE,
          block: "東A",
          number: "03a",
          title: "遅参頒布物",
          price: 700,
          purchaseStatus: "Late",
          quantity: 1,
          remarks: "午後から頒布",
          priorityLevel: "none",
          manualHallId: "hall-east",
        },
      ],
    },
    eventMetadata: {},
    executeModeItems: {
      [EVENT_NAME]: {
        [EVENT_DATE]: ["item-highest", "item-priority", "item-late"],
      },
    },
    dayModes: {
      [EVENT_NAME]: {
        [EVENT_DATE]: "edit",
      },
    },
    mapData: {
      [EVENT_NAME]: {
        [MAP_NAME]: {
          sheetName: EVENT_DATE,
          rows: 4,
          cols: 4,
          maxRow: 4,
          maxCol: 4,
          cells: [
            {
              row: 1,
              col: 1,
              value: "東A",
              backgroundColor: "#E2E8F0",
              borders: noBorders,
            },
            {
              row: 1,
              col: 2,
              value: 1,
              backgroundColor: "#FFFFFF",
              borders: noBorders,
            },
            {
              row: 2,
              col: 2,
              value: 2,
              backgroundColor: "#FFFFFF",
              borders: noBorders,
            },
            {
              row: 3,
              col: 2,
              value: 3,
              backgroundColor: "#FFFFFF",
              borders: noBorders,
            },
          ],
          mergedCells: [],
          blocks: [
            {
              name: "東A",
              startRow: 1,
              startCol: 1,
              endRow: 4,
              endCol: 4,
              numberCells: [
                { row: 1, col: 2, value: 1 },
                { row: 2, col: 2, value: 2 },
                { row: 3, col: 2, value: 3 },
              ],
              nameCells: [{ row: 1, col: 1 }],
              color: "#DBEAFE",
              id: "block-east-a",
              isAutoDetected: true,
              isWallBlock: false,
            },
          ],
        },
      },
    },
    mapRotationSettings: {
      [EVENT_NAME]: {
        [MAP_NAME]: {
          initialAngle: 0,
          mapTabAngle: 0,
          focusModeAngle: 0,
        },
      },
    },
    routeSettings: {
      [EVENT_NAME]: {
        [MAP_NAME]: {
          isRouteVisible: true,
          visitOrder: [
            {
              row: 1,
              col: 2,
              blockName: "東A",
              number: 1,
              order: 0,
              itemIds: ["item-highest"],
            },
            {
              row: 2,
              col: 2,
              blockName: "東A",
              number: 2,
              order: 1,
              itemIds: ["item-priority"],
            },
            {
              row: 3,
              col: 2,
              blockName: "東A",
              number: 3,
              order: 2,
              itemIds: ["item-late"],
            },
          ],
        },
      },
    },
    hallDefinitions: {
      [EVENT_NAME]: {
        [MAP_NAME]: [
          {
            id: "hall-east",
            name: "東ホール",
            color: "#BFDBFE",
            vertices: [
              { row: 1, col: 1 },
              { row: 1, col: 4 },
              { row: 4, col: 4 },
              { row: 4, col: 1 },
            ],
          },
        ],
      },
    },
    hallRouteSettings: {
      [EVENT_NAME]: {
        [MAP_NAME]: {
          hallOrder: ["hall-east:highest", "hall-east:priority", "hall-east"],
          hallVisitLists: [
            {
              hallId: "hall-east",
              itemIds: ["item-highest", "item-priority", "item-late"],
            },
          ],
        },
      },
    },
    mapViewportSettings: {
      [EVENT_NAME]: {
        [MAP_NAME]: {
          zoomLevel: 100,
          offsetX: 0,
          offsetY: 0,
        },
      },
    },
  },
} as const;

type AuditedTheme = "light" | "dark";

type AuditedViolation = {
  state: string;
  theme: AuditedTheme;
  id: string;
  impact: string | null;
  targets: string[];
};

type ConsolidatedViolation = {
  id: string;
  impact: string | null;
  target: string;
  contexts: string[];
};

const waitForApplication = async (page: Page) => {
  const response = await page.goto("/");
  expect(response).not.toBeNull();
  await expect(page.locator("#loading-screen")).toBeHidden();
  await expect(page.locator("#root")).not.toBeEmpty();
};

const waitForFiniteAnimations = async (page: Page) => {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => {
      const iterations = animation.effect?.getTiming().iterations;
      return (
        iterations === Infinity ||
        (animation.playState !== "pending" && animation.playState !== "running")
      );
    }),
  );
};

const auditCurrentState = async (
  page: Page,
  state: string,
): Promise<AuditedViolation[]> => {
  const violations: AuditedViolation[] = [];

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((selectedTheme) => {
      document.documentElement.setAttribute("data-theme", selectedTheme);
      document.documentElement.classList.toggle(
        "dark",
        selectedTheme === "dark",
      );
    }, theme);
    await waitForFiniteAnimations(page);

    const stateViolations = await page.evaluate(async () => {
      const axeApi = (
        globalThis as typeof globalThis & {
          axe: {
            run(
              context: Document,
              options: { resultTypes: string[] },
            ): Promise<{
              violations: Array<{
                id: string;
                impact: string | null;
                nodes: Array<{ target: string[] }>;
              }>;
            }>;
          };
        }
      ).axe;
      const result = await axeApi.run(document, {
        resultTypes: ["violations"],
      });
      return result.violations
        .filter(({ impact }) =>
          ["moderate", "serious", "critical"].includes(impact ?? ""),
        )
        .map(({ id, impact, nodes }) => ({
          id,
          impact,
          targets: nodes.map(({ target }) => target.join(" ")),
        }));
    });

    violations.push(
      ...stateViolations.map((violation) => ({
        ...violation,
        state,
        theme,
      })),
    );
  }

  return violations;
};

const openMapLongPressMenu = async (page: Page) => {
  const mapToggle = page.getByTitle("リスト表示に切り替え");
  await mapToggle.dispatchEvent("pointerdown", {
    button: 0,
    isPrimary: true,
    pointerType: "mouse",
  });
  await page.waitForTimeout(550);
  await mapToggle.dispatchEvent("pointerup", {
    button: 0,
    isPrimary: true,
    pointerType: "mouse",
  });
};

const openItemLongPressMenu = async (page: Page, itemId: string) => {
  const card = page
    .locator(`[data-item-id="${itemId}"]`)
    .first()
    .locator(":scope > div.rounded-lg")
    .first();
  await card.dispatchEvent("pointerdown", {
    button: 0,
    isPrimary: true,
    pointerType: "mouse",
  });
  await page.waitForTimeout(550);
  await card.dispatchEvent("pointerup", {
    button: 0,
    isPrimary: true,
    pointerType: "mouse",
  });
};

const consolidateViolations = (
  violations: AuditedViolation[],
): ConsolidatedViolation[] => {
  const consolidated = new Map<
    string,
    Omit<ConsolidatedViolation, "contexts"> & { contexts: Set<string> }
  >();

  for (const violation of violations) {
    for (const target of violation.targets) {
      const key = `${violation.id}\u0000${violation.impact ?? ""}\u0000${target}`;
      const current = consolidated.get(key) ?? {
        id: violation.id,
        impact: violation.impact,
        target,
        contexts: new Set<string>(),
      };
      current.contexts.add(`${violation.state}:${violation.theme}`);
      consolidated.set(key, current);
    }
  }

  return [...consolidated.values()]
    .map(({ contexts, ...violation }) => ({
      ...violation,
      contexts: [...contexts].sort(),
    }))
    .sort((left, right) =>
      `${left.id}:${left.target}`.localeCompare(`${right.id}:${right.target}`),
    );
};

test("@a11y representative list, focus, map, and dialog flows have no moderate-or-higher violations", async ({
  page,
}) => {
  test.setTimeout(600_000);
  await page.addInitScript({ content: axe.source });
  await waitForApplication(page);

  const violations: AuditedViolation[] = [];
  const backupInput = page.locator(
    'input[aria-label="バックアップファイルを選択"]',
  );
  await backupInput.setInputFiles({
    name: "a11y-representative-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(representativeBackup), "utf8"),
  });

  const restoreDialog = page.getByRole("dialog", {
    name: "バックアップからイベントを復元",
  });
  await expect(restoreDialog).toBeVisible();
  violations.push(...(await auditCurrentState(page, "backup-restore-dialog")));
  await restoreDialog.getByRole("radio", { name: /同名で置換/ }).check();
  await restoreDialog.getByRole("button", { name: "置換して復元" }).click();
  await expect(restoreDialog).toBeHidden();
  await expect(page.getByRole("heading", { name: EVENT_NAME })).toBeVisible();
  await expect(page.getByText("実行リストアイテム")).toBeVisible();

  violations.push(...(await auditCurrentState(page, "canonical-edit-list")));

  await openItemLongPressMenu(page, "item-highest");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "アイテム編集" }),
  ).toBeVisible();
  violations.push(...(await auditCurrentState(page, "item-edit-dialog")));
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();

  await page.getByTitle("ホール間移動順序").click();
  await expect(
    page.getByRole("heading", { name: "ホール間移動順序" }),
  ).toBeVisible();
  violations.push(...(await auditCurrentState(page, "hall-order-dialog")));
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();

  await page.getByTitle("集中モード").click();
  await expect(page.locator("#focus-mode-footer")).toBeVisible();
  violations.push(...(await auditCurrentState(page, "focus-mode")));

  const focusAddTrigger = page.getByTitle("新規アイテム追加");
  await expect(focusAddTrigger).toBeVisible({ timeout: 5_000 });
  await focusAddTrigger.click({ timeout: 5_000 });
  const focusAddDialog = page.getByRole("dialog", {
    name: "新規アイテム追加",
  });
  await expect(focusAddDialog).toBeVisible({ timeout: 5_000 });
  violations.push(...(await auditCurrentState(page, "focus-add-dialog")));
  await focusAddDialog
    .getByRole("button", { name: "キャンセル", exact: true })
    .click({ timeout: 5_000 });

  const phaseSelect = page.getByLabel("phase");
  await expect(phaseSelect).toBeVisible({ timeout: 5_000 });
  await phaseSelect.selectOption("postponed", { timeout: 5_000 });
  const phaseDialog = page.getByRole("dialog", {
    name: "フェーズを切り替えますか？",
  });
  await expect(phaseDialog).toBeVisible({ timeout: 5_000 });
  violations.push(...(await auditCurrentState(page, "phase-change-dialog")));
  await phaseDialog
    .getByRole("button", { name: "キャンセル", exact: true })
    .click({ timeout: 5_000 });

  await page.getByTitle("マップを表示").click();
  await expect(page.getByTitle("マップを非表示")).toBeVisible();
  violations.push(...(await auditCurrentState(page, "focus-mode-map")));
  await page.getByTitle("編集モード").click();

  await page.getByTitle("マップ表示に切り替え").click();
  await expect(page.getByTitle("リスト表示に切り替え")).toBeVisible();
  violations.push(...(await auditCurrentState(page, "map-view")));

  await openMapLongPressMenu(page);
  const visitListAction = page.getByRole("button", { name: /訪問リスト/ });
  await expect(visitListAction).toBeVisible();
  await visitListAction.click();
  await expect(
    page.getByRole("heading", { name: "訪問先リスト" }),
  ).toBeVisible();
  violations.push(...(await auditCurrentState(page, "map-visit-list-dialog")));
  await page.getByTitle("閉じる").click();

  await openMapLongPressMenu(page);
  const hallDefinitionAction = page.getByRole("button", { name: /ホール定義/ });
  await expect(hallDefinitionAction).toBeVisible();
  await hallDefinitionAction.click();
  await expect(
    page.getByRole("heading", { name: "ホール定義エリア設定" }),
  ).toBeVisible();
  violations.push(...(await auditCurrentState(page, "map-hall-dialog")));

  expect(consolidateViolations(violations)).toEqual([]);
});
