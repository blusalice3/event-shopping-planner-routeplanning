// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PersistenceCommandPort } from "../ports/PersistenceCommandPort";
import {
  DEFAULT_BLOCK_DETECTION_SETTINGS,
  type BlockDetectionSettings,
} from "../../types/map";
import type { ShoppingItem } from "../../types/item";
import type { AppBackupV1 } from "../../utils/appBackup";
import { LARGE_XLSX_RESTORE_DEFER_ITEM_THRESHOLD } from "../../features/events/uiOrchestration";
import type { EventTransferCommandPorts } from "./useEventTransferCommands";
import { useEventTransferCommands } from "./useEventTransferCommands";

const eventItem: ShoppingItem = {
  id: "item-1",
  circle: "A",
  eventDate: "1日目",
  block: "A",
  number: "01",
  title: "",
  price: null,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
};

const emptySnapshot = () => ({
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
});

const createPersistenceCommands = (): PersistenceCommandPort => ({
  loadPreference: vi.fn(() => null),
  savePreference: vi.fn(),
  readBlockDetectionSettings: vi.fn(() => null),
  readBlockDetectionSettingsForBackup: vi.fn(() => ({})),
  saveBlockDetectionSettings: vi.fn(),
  removeBlockDetectionSettingsForEvent: vi.fn(),
  renameBlockDetectionSettingsForEvent: vi.fn(),
  migrateFromLocalStorage: vi.fn(async () => ({
    status: "not-needed" as const,
  })),
  adoptRecoveryCandidate: vi.fn(async () => undefined),
  saveEventLists: vi.fn(async () => undefined),
  saveEventMetadata: vi.fn(async () => undefined),
  saveExecuteModeItems: vi.fn(async () => undefined),
  saveDayModes: vi.fn(async () => undefined),
  saveMapDataChanges: vi.fn(async () => undefined),
  saveMapRotationSettings: vi.fn(async () => undefined),
  saveRouteSettings: vi.fn(async () => undefined),
  saveHallDefinitions: vi.fn(async () => undefined),
  saveHallRouteSettings: vi.fn(async () => undefined),
  saveMapViewportSettings: vi.fn(async () => undefined),
  restoreAppDataAtomically: vi.fn(async () => undefined),
  commitApplicationSnapshotAtomically: vi.fn(async () => undefined),
  deleteEventAtomically: vi.fn(async () => undefined),
  renameEventAtomically: vi.fn(async () => undefined),
  restoreAppDataWithBlockDetectionSettings: vi.fn(async () => undefined),
});

const createBackup = (items: ShoppingItem[] = [eventItem]): AppBackupV1 => ({
  kind: "event-shopping-planner-backup",
  version: 1,
  exportedAt: "2026-08-09T00:00:00.000Z",
  eventSettings: {
    blockDetectionSettings: {
      source: structuredClone(DEFAULT_BLOCK_DETECTION_SETTINGS),
    },
  },
  data: {
    ...emptySnapshot(),
    eventLists: { source: items },
  },
});

const createPorts = (
  overrides: Partial<EventTransferCommandPorts> = {},
): EventTransferCommandPorts => {
  const persistenceCommands = createPersistenceCommands();
  return {
    appRuntime: {
      persistenceCommands,
      xlsxCommands: {
        importWorkbook: vi.fn(),
        exportWorkbook: vi.fn(),
      },
      downloadXlsx: vi.fn(),
    },
    ...emptySnapshot(),
    startupState: { status: "ready" },
    exportEventName: null,
    pendingBackup: null,
    pendingXlsxRestoreCompletion: null,
    navigationCommands: {
      openEvent: vi.fn(),
      showEventList: vi.fn(),
    },
    clearSelection: vi.fn(),
    runExclusiveRestore: vi.fn(async (_values, restore) => restore()),
    openExport: vi.fn(),
    confirmEventOverlay: vi.fn(),
    openBackupRestore: vi.fn(),
    confirmBackupRestore: vi.fn(),
    startXlsxOperation: vi.fn(() => "xlsx-operation-1"),
    updateXlsxOperation: vi.fn(),
    clearXlsxOperation: vi.fn(),
    setEventLists: vi.fn(),
    setEventMetadata: vi.fn(),
    setExecuteModeItemsCommitted: vi.fn(),
    setDayModes: vi.fn(),
    setMapData: vi.fn(),
    setMapRotationSettings: vi.fn(),
    setRouteSettings: vi.fn(),
    setHallDefinitions: vi.fn(),
    setHallRouteSettings: vi.fn(),
    setMapViewportSettings: vi.fn(),
    ...overrides,
  };
};

describe("useEventTransferCommands", () => {
  it("opens export options only for an event with exportable items", () => {
    const ports = createPorts({ eventLists: { event: [eventItem] } });
    const { result } = renderHook(() => useEventTransferCommands(ports));

    act(() => result.current.handleExportEvent("event"));

    expect(ports.openExport).toHaveBeenCalledWith("event");
  });

  it("restores app data and auxiliary settings through one persistence command", async () => {
    const settings = structuredClone(
      DEFAULT_BLOCK_DETECTION_SETTINGS,
    ) as BlockDetectionSettings;
    const ports = createPorts({ pendingBackup: createBackup() });
    const { result } = renderHook(() => useEventTransferCommands(ports));

    await act(async () => {
      await result.current.handleBackupRestore("source", "target");
    });

    expect(
      ports.appRuntime.persistenceCommands
        .restoreAppDataWithBlockDetectionSettings,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        eventLists: { target: [eventItem] },
      }),
      "target",
      settings,
    );
    expect(ports.setEventLists).toHaveBeenCalledWith({
      target: [eventItem],
    });
    expect(ports.navigationCommands.openEvent).toHaveBeenCalledWith(
      "target",
      "1日目",
    );
    expect(ports.clearSelection).toHaveBeenCalledOnce();
  });

  it("keeps a large XLSX restore on the event list after the atomic commit", async () => {
    const restoredItems = Array.from(
      { length: LARGE_XLSX_RESTORE_DEFER_ITEM_THRESHOLD },
      (_, index): ShoppingItem => ({
        ...eventItem,
        id: `large-${index}`,
      }),
    );
    const alertSpy = vi.spyOn(globalThis, "alert").mockImplementation(() => {});
    const ports = createPorts({
      pendingBackup: createBackup(restoredItems),
      pendingXlsxRestoreCompletion: {
        errors: [],
        itemCount: restoredItems.length,
      },
    });
    const { result } = renderHook(() => useEventTransferCommands(ports));

    await act(async () => {
      await result.current.handleBackupRestore("source", "large-import");
    });

    expect(
      ports.appRuntime.persistenceCommands
        .restoreAppDataWithBlockDetectionSettings,
    ).toHaveBeenCalledOnce();
    expect(ports.navigationCommands.openEvent).not.toHaveBeenCalled();
    expect(ports.navigationCommands.showEventList).toHaveBeenCalledOnce();
    expect(alertSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `大規模なExcel復元（${restoredItems.length}件）のため、リストは自動で開かずイベント一覧に戻りました。`,
      ),
    );
    alertSpy.mockRestore();
  });

  it("still opens an XLSX restore immediately below the large-list boundary", async () => {
    const restoredItems = Array.from(
      { length: LARGE_XLSX_RESTORE_DEFER_ITEM_THRESHOLD - 1 },
      (_, index): ShoppingItem => ({
        ...eventItem,
        id: `boundary-${index}`,
      }),
    );
    const alertSpy = vi.spyOn(globalThis, "alert").mockImplementation(() => {});
    const ports = createPorts({
      pendingBackup: createBackup(restoredItems),
      pendingXlsxRestoreCompletion: {
        errors: [],
        itemCount: restoredItems.length,
      },
    });
    const { result } = renderHook(() => useEventTransferCommands(ports));

    await act(async () => {
      await result.current.handleBackupRestore("source", "boundary-import");
    });

    expect(ports.navigationCommands.openEvent).toHaveBeenCalledWith(
      "boundary-import",
      "1日目",
    );
    expect(ports.navigationCommands.showEventList).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      `boundary-importを作成しました。\n${restoredItems.length}件`,
    );
    alertSpy.mockRestore();
  });

  it("exposes Worker progress and cancels the active XLSX operation", async () => {
    let progressListener:
      | ((
          requestId: string,
          progress: {
            phase: "serialize";
            completed: number;
            total: number;
          },
        ) => void)
      | undefined;
    let rejectExport: ((error: Error) => void) | undefined;
    let exportSignal: AbortSignal | undefined;
    const ports = createPorts({
      eventLists: { event: [eventItem] },
      exportEventName: "event",
    });
    ports.appRuntime.xlsxCommands.exportWorkbook = vi.fn(
      (_snapshot, signal, onProgress) => {
        exportSignal = signal;
        progressListener = onProgress as typeof progressListener;
        return new Promise<Uint8Array>((_resolve, reject) => {
          rejectExport = reject;
        });
      },
    );
    const { result } = renderHook(() => useEventTransferCommands(ports));

    let operation!: Promise<void>;
    act(() => {
      operation = result.current.handleConfirmExport({
        includeItems: true,
        includeLayoutInfo: false,
        includeMapData: false,
        includeRouteInfo: false,
        format: "simple",
      });
    });
    act(() => {
      progressListener?.("00000000-0000-4000-8000-000000000001", {
        phase: "serialize",
        completed: 3,
        total: 10,
      });
    });
    expect(ports.updateXlsxOperation).toHaveBeenLastCalledWith(
      "xlsx-operation-1",
      {
        kind: "export",
        progress: { phase: "serialize", completed: 3, total: 10 },
        cancelRequested: false,
      },
    );

    act(() => result.current.cancelXlsxOperation());
    expect(exportSignal?.aborted).toBe(true);
    expect(ports.updateXlsxOperation).toHaveBeenLastCalledWith(
      "xlsx-operation-1",
      {
        kind: "export",
        progress: { phase: "serialize", completed: 3, total: 10 },
        cancelRequested: true,
      },
    );

    await act(async () => {
      rejectExport?.(new DOMException("cancelled", "AbortError"));
      await operation;
    });
    expect(ports.clearXlsxOperation).toHaveBeenCalledWith("xlsx-operation-1");

    const updateCount = vi.mocked(ports.updateXlsxOperation).mock.calls.length;
    act(() => {
      progressListener?.("00000000-0000-4000-8000-000000000001", {
        phase: "serialize",
        completed: 10,
        total: 10,
      });
    });
    expect(ports.updateXlsxOperation).toHaveBeenCalledTimes(updateCount);
  });
});
