import { describe, expect, it } from "vitest";
import type { PersistenceSnapshot } from "../../app/ports/PersistenceCommandPort";
import type {
  LoadResult,
  PersistenceRecordOperations,
} from "../contracts/persistence";
import { DATA_KEY, STORES, type StoreName } from "../db/constants";
import { createEventRepository } from "./eventRepository";
import { createSettingsRepository } from "./settingsRepository";
import { createSyncQueueRepository } from "./syncQueueRepository";

interface RecordOperationCall {
  readonly kind: "load" | "save";
  readonly storeName: StoreName;
  readonly key: string;
  readonly data?: unknown;
}

function createOperationsFixture(): {
  readonly calls: RecordOperationCall[];
  readonly operations: PersistenceRecordOperations;
} {
  const calls: RecordOperationCall[] = [];
  return {
    calls,
    operations: {
      async save<T>(storeName: StoreName, key: string, data: T) {
        calls.push({ kind: "save", storeName, key, data });
      },
      async load<T>(storeName: StoreName, key: string): Promise<LoadResult<T>> {
        calls.push({ kind: "load", storeName, key });
        return { status: "missing", data: null };
      },
    },
  };
}

describe("persistence repository contracts", () => {
  it("binds every event repository method to its fixed data record", async () => {
    const { calls, operations } = createOperationsFixture();
    const repository = createEventRepository(operations);
    const eventLists: PersistenceSnapshot["eventLists"] = { event: [] };
    const eventMetadata: PersistenceSnapshot["eventMetadata"] = {
      event: { title: "event" },
    };
    const executeModeItems: PersistenceSnapshot["executeModeItems"] = {
      event: { day: ["item"] },
    };
    const dayModes: PersistenceSnapshot["dayModes"] = {
      event: { day: "execute" },
    };

    await repository.saveEventLists(eventLists);
    await repository.loadEventLists();
    await repository.saveEventMetadata(eventMetadata);
    await repository.loadEventMetadata();
    await repository.saveExecuteModeItems(executeModeItems);
    await repository.loadExecuteModeItems();
    await repository.saveDayModes(dayModes);
    await repository.loadDayModes();

    expect(calls).toEqual([
      {
        kind: "save",
        storeName: STORES.EVENT_LISTS,
        key: DATA_KEY,
        data: eventLists,
      },
      { kind: "load", storeName: STORES.EVENT_LISTS, key: DATA_KEY },
      {
        kind: "save",
        storeName: STORES.EVENT_METADATA,
        key: DATA_KEY,
        data: eventMetadata,
      },
      { kind: "load", storeName: STORES.EVENT_METADATA, key: DATA_KEY },
      {
        kind: "save",
        storeName: STORES.EXECUTE_MODE_ITEMS,
        key: DATA_KEY,
        data: executeModeItems,
      },
      { kind: "load", storeName: STORES.EXECUTE_MODE_ITEMS, key: DATA_KEY },
      {
        kind: "save",
        storeName: STORES.DAY_MODES,
        key: DATA_KEY,
        data: dayModes,
      },
      { kind: "load", storeName: STORES.DAY_MODES, key: DATA_KEY },
    ]);
  });

  it("binds every settings repository method to its fixed data record", async () => {
    const { calls, operations } = createOperationsFixture();
    const repository = createSettingsRepository(operations);
    const mapRotationSettings = { event: { day: 90 } };
    const routeSettings = { event: { day: { algorithm: "shortest" } } };
    const hallDefinitions = { event: { day: [{ name: "west" }] } };
    const hallRouteSettings = { event: { day: { start: "west" } } };
    const mapViewportSettings = { event: { day: { zoom: 1 } } };

    await repository.saveMapRotationSettings(mapRotationSettings);
    await repository.loadMapRotationSettings();
    await repository.saveRouteSettings(routeSettings);
    await repository.loadRouteSettings();
    await repository.saveHallDefinitions(hallDefinitions);
    await repository.loadHallDefinitions();
    await repository.saveHallRouteSettings(hallRouteSettings);
    await repository.loadHallRouteSettings();
    await repository.saveMapViewportSettings(mapViewportSettings);
    await repository.loadMapViewportSettings();

    expect(calls).toEqual([
      {
        kind: "save",
        storeName: STORES.MAP_ROTATION_SETTINGS,
        key: DATA_KEY,
        data: mapRotationSettings,
      },
      { kind: "load", storeName: STORES.MAP_ROTATION_SETTINGS, key: DATA_KEY },
      {
        kind: "save",
        storeName: STORES.ROUTE_SETTINGS,
        key: DATA_KEY,
        data: routeSettings,
      },
      { kind: "load", storeName: STORES.ROUTE_SETTINGS, key: DATA_KEY },
      {
        kind: "save",
        storeName: STORES.HALL_DEFINITIONS,
        key: DATA_KEY,
        data: hallDefinitions,
      },
      { kind: "load", storeName: STORES.HALL_DEFINITIONS, key: DATA_KEY },
      {
        kind: "save",
        storeName: STORES.HALL_ROUTE_SETTINGS,
        key: DATA_KEY,
        data: hallRouteSettings,
      },
      { kind: "load", storeName: STORES.HALL_ROUTE_SETTINGS, key: DATA_KEY },
      {
        kind: "save",
        storeName: STORES.MAP_VIEWPORT_SETTINGS,
        key: DATA_KEY,
        data: mapViewportSettings,
      },
      { kind: "load", storeName: STORES.MAP_VIEWPORT_SETTINGS, key: DATA_KEY },
    ]);
  });

  it("keeps sync queue access scoped to the exact data key", async () => {
    const { calls, operations } = createOperationsFixture();
    const repository = createSyncQueueRepository(operations);
    const queue = [{ operation: "sync" }];

    await repository.savePayload(queue);
    await repository.loadPayload();

    expect(calls).toEqual([
      {
        kind: "save",
        storeName: STORES.SYNC_QUEUE,
        key: DATA_KEY,
        data: queue,
      },
      { kind: "load", storeName: STORES.SYNC_QUEUE, key: DATA_KEY },
    ]);
  });
});
