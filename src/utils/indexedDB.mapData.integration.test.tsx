import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { CellBorders, DayMapData, MapDataStore } from '../types/map';
import { db } from './indexedDB';

const emptyBorders: CellBorders = {
  top: null,
  right: null,
  bottom: null,
  left: null,
};

function makeDayMap(value: string): DayMapData {
  return {
    sheetName: value,
    maxRow: 2,
    maxCol: 2,
    cells: [
      {
        row: 1,
        col: 1,
        value,
        backgroundColor: null,
        fontColor: null,
        borders: emptyBorders,
        isMerged: false,
        isVerticalText: false,
      },
    ],
    mergedCells: [],
    blocks: [],
  };
}

async function loadStoredMapData(): Promise<MapDataStore> {
  const result = await db.loadMapData();
  expect(result.status).not.toBe('error');
  return result.data ?? {};
}

// 各テストは同じDBを共有するため、イベント名はテストごとに固有にする
describe('db.saveMapDataChanges', () => {
  it('saves newly added event maps', async () => {
    const next: MapDataStore = {
      新規イベント: {
        '1日目マップ': makeDayMap('a1'),
        '2日目マップ': makeDayMap('a2'),
      },
    };

    await db.saveMapDataChanges({}, next);

    const stored = await loadStoredMapData();
    expect(Object.keys(stored['新規イベント']).sort()).toEqual(['1日目マップ', '2日目マップ']);
    expect(stored['新規イベント']['1日目マップ'].cells[0].value).toBe('a1');
  });

  it('deletes removed event maps and keeps other events', async () => {
    const initial: MapDataStore = {
      削除イベント: { '1日目マップ': makeDayMap('a1') },
      維持イベント: { '1日目マップ': makeDayMap('b1') },
    };
    await db.saveMapDataChanges({}, initial);

    const next: MapDataStore = {
      維持イベント: initial['維持イベント'],
    };
    await db.saveMapDataChanges(initial, next);

    const stored = await loadStoredMapData();
    expect(stored['削除イベント']).toBeUndefined();
    expect(stored['維持イベント']['1日目マップ'].cells[0].value).toBe('b1');
  });

  it('overwrites only changed day maps on re-import of the same event', async () => {
    const initial: MapDataStore = {
      上書きイベント: {
        '1日目マップ': makeDayMap('old-1'),
        '2日目マップ': makeDayMap('old-2'),
      },
    };
    await db.saveMapDataChanges({}, initial);

    const next: MapDataStore = {
      上書きイベント: {
        '1日目マップ': makeDayMap('new-1'),
        '2日目マップ': initial['上書きイベント']['2日目マップ'],
      },
    };
    await db.saveMapDataChanges(initial, next);

    const stored = await loadStoredMapData();
    expect(stored['上書きイベント']['1日目マップ'].cells[0].value).toBe('new-1');
    expect(stored['上書きイベント']['2日目マップ'].cells[0].value).toBe('old-2');
  });

  it('restores data after delete-then-reimport of the same event', async () => {
    const imported: MapDataStore = {
      再取込イベント: { '1日目マップ': makeDayMap('a1') },
    };
    await db.saveMapDataChanges({}, imported);

    // イベント削除
    await db.saveMapDataChanges(imported, {});
    expect((await loadStoredMapData())['再取込イベント']).toBeUndefined();

    // 同じxlsxを再インポート
    const reimported: MapDataStore = {
      再取込イベント: { '1日目マップ': makeDayMap('a1') },
    };
    await db.saveMapDataChanges({}, reimported);

    const stored = await loadStoredMapData();
    expect(stored['再取込イベント']['1日目マップ'].cells[0].value).toBe('a1');
  });
});
