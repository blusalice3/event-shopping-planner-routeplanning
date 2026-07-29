import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { importFromXlsx } from './exportImport';

const headers = [
  'ID',
  'サークル名',
  '参加日',
  'ブロック',
  'ナンバー',
  'タイトル',
  '価格',
  '数量',
  'ステータス',
  '備考',
  'URL',
  '優先度',
  '保護レベル',
  '追加元',
  '手動ホール',
  '限数実購入数',
];

const createWorkbookFile = async (
  rows: Array<{
    id: string;
    quantity: ExcelJS.CellValue;
    status?: string;
    limited?: ExcelJS.CellValue;
  }>,
): Promise<File> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('アイテムデータ');
  sheet.addRow(headers);
  rows.forEach((row) => {
    sheet.addRow([
      row.id,
      `circle-${row.id}`,
      'day1',
      'A',
      '01a',
      `title-${row.id}`,
      100,
      row.quantity,
      row.status ?? 'None',
      '',
      '',
      '',
      '',
      '',
      '',
      row.limited ?? null,
    ]);
  });
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], 'limited-purchase.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
};

describe('importFromXlsx limited purchase quantity cells', () => {
  it('imports strict positive integer scalar cells for quantity and limited actual', async () => {
    const file = await createWorkbookFile([
      {
        id: 'string-leading-zero',
        quantity: '05',
        status: 'LimitedPurchase',
        limited: '02',
      },
      {
        id: 'number',
        quantity: 2,
        status: 'LimitedPurchase',
        limited: 1,
      },
    ]);

    const result = await importFromXlsx(file);

    expect(result.success).toBe(true);
    expect(result.items.find((item) => item.id === 'string-leading-zero')).toMatchObject({
      quantity: 5,
      purchaseStatus: 'LimitedPurchase',
      limitedPurchasedQuantity: 2,
    });
    expect(result.items.find((item) => item.id === 'number')).toMatchObject({
      quantity: 2,
      purchaseStatus: 'LimitedPurchase',
      limitedPurchasedQuantity: 1,
    });
    expect(result.itemFallbackWarnings).toBeUndefined();
  });

  it.each([
    ['empty', null],
    ['zero', 0],
    ['decimal-number', 2.5],
    ['exponent', '1e3'],
    ['hex', '0x10'],
    ['decimal-string', '2.0'],
    ['comma', '1,000'],
    ['full-width', '５'],
  ] as const)('falls back invalid quantity cell %s to one', async (id, quantity) => {
    const file = await createWorkbookFile([{ id, quantity }]);

    const result = await importFromXlsx(file);

    expect(result.success).toBe(true);
    expect(result.items[0]).toMatchObject({ id, quantity: 1 });
    expect(result.itemFallbackWarnings?.[0].itemId).toBe(id);
  });

  it.each([
    ['zero', 0],
    ['decimal-number', 2.5],
    ['exponent', '1e3'],
    ['hex', '0x10'],
    ['decimal-string', '2.0'],
    ['comma', '1,000'],
    ['full-width', '５'],
    ['equals-planned', 5],
    ['greater-than-planned', 6],
  ] as const)('clears invalid limited actual cell %s', async (id, limited) => {
    const file = await createWorkbookFile([
      {
        id,
        quantity: 5,
        status: 'LimitedPurchase',
        limited,
      },
    ]);

    const result = await importFromXlsx(file);

    expect(result.success).toBe(true);
    expect(result.items[0]).toMatchObject({ id, quantity: 5, purchaseStatus: 'LimitedPurchase' });
    expect(result.items[0]).not.toHaveProperty('limitedPurchasedQuantity');
    expect(result.itemFallbackWarnings?.[0].itemId).toBe(id);
  });

  it('warns and removes limited actual values on non-limited rows', async () => {
    const file = await createWorkbookFile([
      {
        id: 'non-limited',
        quantity: 5,
        status: 'Purchased',
        limited: 2,
      },
    ]);

    const result = await importFromXlsx(file);

    expect(result.success).toBe(true);
    expect(result.items[0]).toMatchObject({ id: 'non-limited', purchaseStatus: 'Purchased' });
    expect(result.items[0]).not.toHaveProperty('limitedPurchasedQuantity');
    expect(result.itemFallbackWarnings?.[0].itemId).toBe('non-limited');
  });

  it('imports formula and shared formula results without recalculating them', async () => {
    const file = await createWorkbookFile([
      {
        id: 'formula',
        quantity: { formula: '2+3', result: '05' },
        status: 'LimitedPurchase',
        limited: { formula: '1+1', result: '02' },
      },
      {
        id: 'shared',
        quantity: { sharedFormula: 'H2', result: 6 },
        status: 'LimitedPurchase',
        limited: { sharedFormula: 'P2', result: 2 },
      },
    ]);

    const result = await importFromXlsx(file);

    expect(result.success).toBe(true);
    expect(result.items.find((item) => item.id === 'formula')).toMatchObject({
      quantity: 5,
      purchaseStatus: 'LimitedPurchase',
      limitedPurchasedQuantity: 2,
    });
    expect(result.items.find((item) => item.id === 'shared')).toMatchObject({
      quantity: 6,
      purchaseStatus: 'LimitedPurchase',
      limitedPurchasedQuantity: 2,
    });
  });

  it('falls back quantity and clears limited actual when formula result is missing', async () => {
    const file = await createWorkbookFile([
      {
        id: 'missing-result',
        quantity: { formula: '2+3' },
        status: 'LimitedPurchase',
        limited: { formula: '1+1' },
      },
    ]);

    const result = await importFromXlsx(file);
    const item = result.items[0];

    expect(item.quantity).toBe(1);
    expect(item).not.toHaveProperty('limitedPurchasedQuantity');
    expect(result.itemFallbackWarnings?.[0].reasons).toEqual(
      expect.arrayContaining([
        '購入予定量「数式結果なし」は不正のため1で補完しました',
        '限数実購入数「数式結果なし」は不正のため未入力にしました',
      ]),
    );
  });

  it('rejects rich text and hyperlink object cells for quantity-like columns', async () => {
    const file = await createWorkbookFile([
      {
        id: 'objects',
        quantity: { richText: [{ text: '5' }] } as ExcelJS.CellValue,
        status: 'LimitedPurchase',
        limited: { text: '2', hyperlink: 'https://example.com' } as ExcelJS.CellValue,
      },
    ]);

    const result = await importFromXlsx(file);
    const item = result.items[0];

    expect(item.quantity).toBe(1);
    expect(item).not.toHaveProperty('limitedPurchasedQuantity');
    expect(result.itemFallbackWarnings?.[0].reasons).toEqual(
      expect.arrayContaining([
        '購入予定量「非対応セル形式」は不正のため1で補完しました',
        '限数実購入数「非対応セル形式」は不正のため未入力にしました',
      ]),
    );
  });

  it('imports old format workbooks without column 16 as missing limited actual', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('アイテムデータ');
    sheet.addRow(headers.slice(0, 15));
    sheet.addRow([
      'old',
      'circle-old',
      'day1',
      'A',
      '01a',
      'title-old',
      100,
      5,
      'LimitedPurchase',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
    const buffer = await workbook.xlsx.writeBuffer();
    const file = new File([buffer], 'old.xlsx');

    const result = await importFromXlsx(file);

    expect(result.success).toBe(true);
    expect(result.items[0]).toMatchObject({ id: 'old', quantity: 5, purchaseStatus: 'LimitedPurchase' });
    expect(result.items[0]).not.toHaveProperty('limitedPurchasedQuantity');
    expect(result.itemFallbackWarnings).toBeUndefined();
  });
});
