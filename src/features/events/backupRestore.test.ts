import { describe, expect, it } from "vitest";
import type { AppData } from "../../utils/indexedDB";
import { buildEventRestoreData } from "./backupRestore";

const APP_DATA_SECTIONS = [
  "eventLists",
  "eventMetadata",
  "executeModeItems",
  "dayModes",
  "mapData",
  "mapRotationSettings",
  "routeSettings",
  "hallDefinitions",
  "hallRouteSettings",
  "mapViewportSettings",
] as const satisfies readonly (keyof AppData)[];

function emptyAppData(): AppData {
  return {
    eventLists: {},
    eventMetadata: {},
    executeModeItems: {},
    dayModes: {},
    mapData: {},
    mapRotationSettings: {},
    routeSettings: {},
    hallDefinitions: {},
    hallRouteSettings: {},
    mapViewportSettings: {},
  };
}

function makeEventData(eventName: string, label: string): AppData {
  return {
    eventLists: {
      [eventName]: [
        {
          id: `${label}-item`,
          details: { tags: [`${label}-tag`] },
        },
      ],
    },
    eventMetadata: {
      [eventName]: {
        label,
        details: { flags: [true] },
      },
    },
    executeModeItems: {
      [eventName]: {
        "1日目": [`${label}-item`],
      },
    },
    dayModes: {
      [eventName]: {
        "1日目": `${label}-mode`,
      },
    },
    mapData: {
      [eventName]: {
        "1日目マップ": {
          label,
          cells: [{ value: label }],
        },
      },
    },
    mapRotationSettings: {
      [eventName]: {
        "1日目マップ": { angle: label.length },
      },
    },
    routeSettings: {
      [eventName]: {
        "1日目マップ": { route: [label] },
      },
    },
    hallDefinitions: {
      [eventName]: {
        "1日目マップ": [{ name: label, points: [[1, 2]] }],
      },
    },
    hallRouteSettings: {
      [eventName]: {
        "1日目マップ": { route: [label] },
      },
    },
    mapViewportSettings: {
      [eventName]: {
        "1日目マップ": {
          center: { x: label.length, y: 1 },
        },
      },
    },
  };
}

function mergeAppData(...sources: AppData[]): AppData {
  const merged = emptyAppData();

  for (const source of sources) {
    for (const sectionName of APP_DATA_SECTIONS) {
      Object.assign(merged[sectionName], source[sectionName]);
    }
  }

  return merged;
}

describe("buildEventRestoreData", () => {
  it("restores every section while preserving unrelated events without shared references", () => {
    const targetEventName = "復元先イベント";
    const otherEventName = "保持イベント";
    const sourceEventName = "バックアップイベント";
    const current = mergeAppData(
      makeEventData(targetEventName, "old"),
      makeEventData(otherEventName, "keep"),
    );
    const backup = makeEventData(sourceEventName, "restored");

    const result = buildEventRestoreData(
      current,
      backup,
      sourceEventName,
      targetEventName,
    );

    for (const sectionName of APP_DATA_SECTIONS) {
      expect(result[sectionName][targetEventName]).toEqual(
        backup[sectionName][sourceEventName],
      );
      expect(result[sectionName][targetEventName]).not.toBe(
        backup[sectionName][sourceEventName],
      );
      expect(result[sectionName][otherEventName]).toEqual(
        current[sectionName][otherEventName],
      );
      expect(result[sectionName][otherEventName]).not.toBe(
        current[sectionName][otherEventName],
      );
    }

    const restoredItem = result.eventLists[targetEventName][0] as {
      details: { tags: string[] };
    };
    restoredItem.details.tags.push("result-only");
    expect(
      (
        backup.eventLists[sourceEventName][0] as {
          details: { tags: string[] };
        }
      ).details.tags,
    ).toEqual(["restored-tag"]);

    const keptMap = result.mapData[otherEventName]["1日目マップ"] as {
      cells: Array<{ value: string }>;
    };
    keptMap.cells[0].value = "result-only";
    expect(
      (
        current.mapData[otherEventName]["1日目マップ"] as {
          cells: Array<{ value: string }>;
        }
      ).cells[0].value,
    ).toBe("keep");
  });

  it("restores under another name without changing the source or other existing events", () => {
    const sourceEventName = "同名の現行イベント";
    const targetEventName = "別名の復元イベント";
    const otherEventName = "既存イベント";
    const current = mergeAppData(
      makeEventData(sourceEventName, "current-source"),
      makeEventData(otherEventName, "current-other"),
    );
    const backup = makeEventData(sourceEventName, "backup-source");
    const currentBefore = mergeAppData(current);
    const backupBefore = mergeAppData(backup);

    const result = buildEventRestoreData(
      current,
      backup,
      sourceEventName,
      targetEventName,
    );

    for (const sectionName of APP_DATA_SECTIONS) {
      expect(result[sectionName][sourceEventName]).toEqual(
        current[sectionName][sourceEventName],
      );
      expect(result[sectionName][otherEventName]).toEqual(
        current[sectionName][otherEventName],
      );
      expect(result[sectionName][targetEventName]).toEqual(
        backup[sectionName][sourceEventName],
      );
    }
    expect(current).toEqual(currentBefore);
    expect(backup).toEqual(backupBefore);
  });

  it("replaces an event with the same name in every section", () => {
    const eventName = "同名イベント";
    const current = mergeAppData(
      makeEventData(eventName, "old"),
      makeEventData("保持イベント", "keep"),
    );
    const backup = makeEventData(eventName, "new");

    const result = buildEventRestoreData(current, backup, eventName, eventName);

    for (const sectionName of APP_DATA_SECTIONS) {
      expect(result[sectionName][eventName]).toEqual(
        backup[sectionName][eventName],
      );
      expect(result[sectionName]["保持イベント"]).toEqual(
        current[sectionName]["保持イベント"],
      );
    }
  });

  it("removes old target data from optional sections missing in the backup", () => {
    const sourceEventName = "一覧だけのバックアップ";
    const targetEventName = "置換対象";
    const current = mergeAppData(
      makeEventData(targetEventName, "old"),
      makeEventData("保持イベント", "keep"),
    );
    const backup = emptyAppData();
    backup.eventLists[sourceEventName] = [
      { id: "restored-item", nested: { values: ["backup"] } },
    ];

    const result = buildEventRestoreData(
      current,
      backup,
      sourceEventName,
      targetEventName,
    );

    expect(result.eventLists[targetEventName]).toEqual(
      backup.eventLists[sourceEventName],
    );
    for (const sectionName of APP_DATA_SECTIONS.slice(1)) {
      expect(result[sectionName]).not.toHaveProperty(targetEventName);
      expect(result[sectionName]["保持イベント"]).toEqual(
        current[sectionName]["保持イベント"],
      );
    }
  });

  it("rejects a missing source event and an empty target name", () => {
    const data = emptyAppData();

    expect(() =>
      buildEventRestoreData(data, data, "存在しないイベント", "復元先"),
    ).toThrow("バックアップにイベント");
    expect(() => buildEventRestoreData(data, data, "任意", "  ")).toThrow(
      "復元先のイベント名",
    );
  });
});
