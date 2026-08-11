import {
  useCallback,
  useEffect,
  useRef,
  type ChangeEvent,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { ExportOptions } from "../../types/export";
import type {
  DayModeState,
  EventMetadata,
  ExecuteModeItems,
  ShoppingItem,
} from "../../types/item";
import type {
  HallDefinitionsStore,
  HallRouteSettingsStore,
  MapDataStore,
  MapRotationSettingsStore,
  MapViewportSettingsStore,
  RouteSettingsStore,
} from "../../types/map";
import {
  PersistenceSettingsRollbackError,
  type PersistenceCommandPort,
  type PersistenceSnapshot,
} from "../ports/PersistenceCommandPort";
import type { AppNavigationCommands } from "../navigation";
import type { PendingXlsxRestoreCompletion } from "../state/appOverlayTypes";
import type { XlsxOperationOverlayActivity } from "../state/appOverlayState";
import type {
  PersistedStateValues,
  PersistenceStartupState,
} from "../../hooks/useIndexedDbPersistence";
import {
  createAppBackup,
  parseAppBackup,
  serializeAppBackup,
  type AppBackupV1,
} from "../../utils/appBackup";
import { downloadBlob } from "../../utils/downloadBlob";
import {
  exportStartupRecoveryBundle,
  type PersistenceRecoveryExportResult,
} from "../../utils/persistenceRecoveryExport";
import { buildEventRestoreData } from "../../features/events/backupRestore";
import {
  buildEventExportFile,
  hasExportableItems,
} from "../../features/events/exportFlow";
import {
  buildXlsxEventRestoreSource,
  toImportedEventData,
} from "../../features/events/fileImport";
import {
  buildImportCompletionMessage,
  buildLargeXlsxRestoreDeferredNotice,
  buildLegacySheetFieldFallbackMessage,
  resolveEventListTab,
  shouldDeferLargeXlsxRestoreOpen,
} from "../../features/events/uiOrchestration";
import type { ItemFallbackWarning } from "../../xlsx/domain/eventWorkbook";
import type { XlsxExecutionPort } from "../../xlsx/port/XlsxExecutionPort";

type StateSetter<T> = Dispatch<SetStateAction<T>>;

export interface EventTransferRuntime {
  readonly persistenceCommands: PersistenceCommandPort;
  readonly xlsxCommands: XlsxExecutionPort;
  readonly downloadXlsx: (bytes: Uint8Array, fileName: string) => void;
}

export interface EventTransferCommandPorts {
  appRuntime: EventTransferRuntime;
  eventLists: Record<string, ShoppingItem[]>;
  eventMetadata: Record<string, EventMetadata>;
  executeModeItems: Record<string, ExecuteModeItems>;
  dayModes: Record<string, DayModeState>;
  mapData: MapDataStore;
  mapRotationSettings: MapRotationSettingsStore;
  routeSettings: RouteSettingsStore;
  hallDefinitions: HallDefinitionsStore;
  hallRouteSettings: HallRouteSettingsStore;
  mapViewportSettings: MapViewportSettingsStore;
  startupState: PersistenceStartupState;
  exportEventName: string | null;
  pendingBackup: AppBackupV1 | null;
  pendingXlsxRestoreCompletion: PendingXlsxRestoreCompletion | null;
  navigationCommands: Pick<
    AppNavigationCommands,
    "openEvent" | "showEventList"
  >;
  clearSelection(): void;
  runExclusiveRestore: <T>(
    restoredValues: PersistedStateValues,
    restore: () => Promise<T>,
  ) => Promise<T>;
  openExport(eventName: string): void;
  confirmEventOverlay(): void;
  openBackupRestore(
    backup: AppBackupV1,
    xlsxCompletion: PendingXlsxRestoreCompletion | null,
  ): void;
  confirmBackupRestore(): void;
  startXlsxOperation(activity: XlsxOperationActivity): string;
  updateXlsxOperation(requestId: string, activity: XlsxOperationActivity): void;
  clearXlsxOperation(requestId: string): void;
  setEventLists: StateSetter<Record<string, ShoppingItem[]>>;
  setEventMetadata: StateSetter<Record<string, EventMetadata>>;
  setExecuteModeItemsCommitted: StateSetter<Record<string, ExecuteModeItems>>;
  setDayModes: StateSetter<Record<string, DayModeState>>;
  setMapData: StateSetter<MapDataStore>;
  setMapRotationSettings: StateSetter<MapRotationSettingsStore>;
  setRouteSettings: StateSetter<RouteSettingsStore>;
  setHallDefinitions: StateSetter<HallDefinitionsStore>;
  setHallRouteSettings: StateSetter<HallRouteSettingsStore>;
  setMapViewportSettings: StateSetter<MapViewportSettingsStore>;
}

export interface EventTransferCommands {
  backupFileInputRef: RefObject<HTMLInputElement>;
  cancelXlsxOperation(): void;
  handleExportEvent(eventName: string): void;
  handleBackupExport(): void;
  handlePersistenceRecoveryExport(): PersistenceRecoveryExportResult;
  handleBackupRestoreRequest(): void;
  handleBackupFileImport(event: ChangeEvent<HTMLInputElement>): Promise<void>;
  handleBackupRestore(
    sourceEventName: string,
    targetEventName: string,
  ): Promise<void>;
  handleConfirmExport(options: ExportOptions): Promise<void>;
  handleExportFileImport(event: ChangeEvent<HTMLInputElement>): Promise<void>;
}

export type XlsxOperationActivity = XlsxOperationOverlayActivity;

interface ActiveXlsxOperation {
  readonly controller: AbortController;
  readonly requestId: string;
  activity: XlsxOperationActivity;
}

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";

export const useEventTransferCommands = ({
  appRuntime,
  eventLists,
  eventMetadata,
  executeModeItems,
  dayModes,
  mapData,
  mapRotationSettings,
  routeSettings,
  hallDefinitions,
  hallRouteSettings,
  mapViewportSettings,
  startupState,
  exportEventName,
  pendingBackup,
  pendingXlsxRestoreCompletion,
  navigationCommands,
  clearSelection,
  runExclusiveRestore,
  openExport,
  confirmEventOverlay,
  openBackupRestore,
  confirmBackupRestore,
  startXlsxOperation,
  updateXlsxOperation,
  clearXlsxOperation,
  setEventLists,
  setEventMetadata,
  setExecuteModeItemsCommitted,
  setDayModes,
  setMapData,
  setMapRotationSettings,
  setRouteSettings,
  setHallDefinitions,
  setHallRouteSettings,
  setMapViewportSettings,
}: EventTransferCommandPorts): EventTransferCommands => {
  const backupFileInputRef = useRef<HTMLInputElement>(null);
  const xlsxOperationRef = useRef<ActiveXlsxOperation | null>(null);

  useEffect(
    () => () => {
      xlsxOperationRef.current?.controller.abort();
    },
    [],
  );

  const cancelXlsxOperation = useCallback(() => {
    const active = xlsxOperationRef.current;
    if (!active) return;
    active.activity = { ...active.activity, cancelRequested: true };
    updateXlsxOperation(active.requestId, active.activity);
    active.controller.abort();
  }, [updateXlsxOperation]);

  const handleExportEvent = useCallback(
    (eventName: string) => {
      const itemsToExport = eventLists[eventName];
      if (!hasExportableItems(itemsToExport)) {
        alert("出力できるアイテムがありません。");
        return;
      }
      openExport(eventName);
    },
    [eventLists, openExport],
  );

  const buildCurrentAppData = useCallback(
    (): PersistenceSnapshot => ({
      eventLists,
      eventMetadata,
      executeModeItems,
      dayModes,
      mapData,
      mapRotationSettings,
      routeSettings,
      hallDefinitions,
      hallRouteSettings,
      mapViewportSettings,
    }),
    [
      dayModes,
      eventLists,
      eventMetadata,
      executeModeItems,
      hallDefinitions,
      hallRouteSettings,
      mapData,
      mapRotationSettings,
      mapViewportSettings,
      routeSettings,
    ],
  );

  const handleBackupExport = useCallback(() => {
    try {
      const currentData = buildCurrentAppData();
      const backup = createAppBackup(currentData, new Date(), {
        blockDetectionSettings:
          appRuntime.persistenceCommands.readBlockDetectionSettingsForBackup(
            Object.keys(currentData.eventLists),
          ),
      });
      const blob = new Blob([serializeAppBackup(backup)], {
        type: "application/json;charset=utf-8",
      });
      const timestamp = backup.exportedAt.replace(/[:.]/g, "-");
      downloadBlob(blob, `event-shopping-planner-backup-${timestamp}.json`);
    } catch {
      console.error("Backup export failed (backup-export-failed).");
      alert(
        "バックアップを完全に保存できなかったため、ファイルを作成しませんでした。現在のデータは変更されていません。",
      );
    }
  }, [appRuntime.persistenceCommands, buildCurrentAppData]);

  const handlePersistenceRecoveryExport =
    useCallback((): PersistenceRecoveryExportResult => {
      if (
        startupState.status !== "recovery-required" ||
        !startupState.recoveryBundle
      ) {
        return { status: "failed" };
      }

      const result = exportStartupRecoveryBundle(startupState.recoveryBundle);
      if (result.status === "failed") {
        console.error(
          "Persistence recovery export failed (recovery-export-failed).",
        );
        alert(
          "退避用JSONを作成できませんでした。保存候補は変更されていません。",
        );
      }
      return result;
    }, [startupState]);

  const handleBackupRestoreRequest = useCallback(() => {
    backupFileInputRef.current?.click();
  }, []);

  const handleBackupFileImport = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      try {
        const result = parseAppBackup(await file.text());
        if (!result.ok) {
          alert(
            `バックアップを読み込めませんでした。\n${result.errors.join("\n")}`,
          );
          return;
        }
        if (Object.keys(result.data.eventLists).length === 0) {
          alert("このバックアップには復元できるイベントがありません。");
          return;
        }
        openBackupRestore(result.backup, null);
      } catch {
        console.error("Backup import failed (backup-import-failed).");
        alert(
          "バックアップを読み込めませんでした。JSONバックアップファイルを選び直してください。",
        );
      }
    },
    [openBackupRestore],
  );

  const handleBackupRestore = useCallback(
    async (sourceEventName: string, targetEventName: string) => {
      if (!pendingBackup) {
        throw new Error("復元するバックアップをもう一度選んでください。");
      }

      const currentData = buildCurrentAppData();
      const isUpdate = Object.prototype.hasOwnProperty.call(
        currentData.eventLists,
        targetEventName,
      );
      const nextData = buildEventRestoreData(
        currentData,
        pendingBackup.data,
        sourceEventName,
        targetEventName,
      );
      const restoredValues: PersistedStateValues = {
        eventLists: nextData.eventLists as Record<string, ShoppingItem[]>,
        eventMetadata: nextData.eventMetadata as Record<string, EventMetadata>,
        executeModeItems: nextData.executeModeItems as Record<
          string,
          ExecuteModeItems
        >,
        dayModes: nextData.dayModes as Record<string, DayModeState>,
        mapData: nextData.mapData as MapDataStore,
        mapRotationSettings:
          nextData.mapRotationSettings as MapRotationSettingsStore,
        routeSettings: nextData.routeSettings as RouteSettingsStore,
        hallDefinitions: nextData.hallDefinitions as HallDefinitionsStore,
        hallRouteSettings: nextData.hallRouteSettings as HallRouteSettingsStore,
        mapViewportSettings:
          nextData.mapViewportSettings as MapViewportSettingsStore,
      };

      try {
        const restoredBlockDetectionSettings =
          pendingBackup.eventSettings.blockDetectionSettings[sourceEventName] ??
          null;
        await runExclusiveRestore(restoredValues, () =>
          appRuntime.persistenceCommands.restoreAppDataWithBlockDetectionSettings(
            nextData,
            targetEventName,
            restoredBlockDetectionSettings,
          ),
        );
      } catch (error) {
        console.error("Atomic backup restore failed (atomic-restore-failed).");
        if (error instanceof PersistenceSettingsRollbackError) {
          throw new Error(
            "イベント本体は復元前のままですが、マップのブロック検出設定だけ元に戻せなかった可能性があります。次回のマップ取り込み前に検出設定を確認してください。",
          );
        }
        throw new Error(
          "復元を完了できませんでした。現在のデータは変更されていません。",
        );
      }

      setEventLists(restoredValues.eventLists);
      setEventMetadata(restoredValues.eventMetadata);
      setExecuteModeItemsCommitted(restoredValues.executeModeItems);
      setDayModes(restoredValues.dayModes);
      setMapData(restoredValues.mapData);
      setMapRotationSettings(restoredValues.mapRotationSettings);
      setRouteSettings(restoredValues.routeSettings);
      setHallDefinitions(restoredValues.hallDefinitions);
      setHallRouteSettings(restoredValues.hallRouteSettings);
      setMapViewportSettings(restoredValues.mapViewportSettings);

      const restoredItems = nextData.eventLists[
        targetEventName
      ] as ShoppingItem[];
      const restoredTab = resolveEventListTab(restoredItems);
      const deferLargeXlsxOpen = shouldDeferLargeXlsxRestoreOpen({
        isXlsxRestore: pendingXlsxRestoreCompletion !== null,
        itemCount: restoredItems.length,
      });
      if (deferLargeXlsxOpen) {
        navigationCommands.showEventList();
      } else if (restoredTab) {
        navigationCommands.openEvent(targetEventName, restoredTab);
      } else {
        navigationCommands.showEventList();
      }
      clearSelection();
      confirmBackupRestore();

      if (pendingXlsxRestoreCompletion) {
        const completionMessage = buildImportCompletionMessage({
          errors: pendingXlsxRestoreCompletion.errors,
          eventName: targetEventName,
          isUpdate,
          itemCount: pendingXlsxRestoreCompletion.itemCount,
        });
        alert(
          deferLargeXlsxOpen
            ? `${completionMessage}\n${buildLargeXlsxRestoreDeferredNotice(
                restoredItems.length,
              )}`
            : completionMessage,
        );
      }
    },
    [
      pendingBackup,
      appRuntime.persistenceCommands,
      buildCurrentAppData,
      setEventLists,
      setEventMetadata,
      setExecuteModeItemsCommitted,
      setDayModes,
      setHallDefinitions,
      setHallRouteSettings,
      setMapData,
      setMapRotationSettings,
      setMapViewportSettings,
      setRouteSettings,
      clearSelection,
      confirmBackupRestore,
      pendingXlsxRestoreCompletion,
      runExclusiveRestore,
      navigationCommands,
    ],
  );

  const handleConfirmExport = useCallback(
    async (options: ExportOptions) => {
      if (!exportEventName) return;

      const itemsToExport = eventLists[exportEventName];
      if (!hasExportableItems(itemsToExport)) {
        return;
      }

      xlsxOperationRef.current?.controller.abort();
      const controller = new AbortController();
      const initialActivity: XlsxOperationActivity = {
        kind: "export",
        progress: null,
        cancelRequested: false,
      };
      const requestId = startXlsxOperation(initialActivity);
      const operation: ActiveXlsxOperation = {
        controller,
        requestId,
        activity: initialActivity,
      };
      xlsxOperationRef.current = operation;
      try {
        const { bytes, filename } = await buildEventExportFile(
          appRuntime.xlsxCommands,
          controller.signal,
          exportEventName,
          itemsToExport,
          options,
          eventMetadata[exportEventName],
          {
            executeModeItems,
            dayModes,
            mapData,
            mapRotationSettings,
            mapViewportSettings,
            routeSettings,
            hallDefinitions,
            hallRouteSettings,
            blockDetectionSettings:
              options.format === "full" && options.includeMapData
                ? appRuntime.persistenceCommands.readBlockDetectionSettingsForBackup(
                    [exportEventName],
                  )
                : {},
          },
          new Date(),
          (_requestId, progress) => {
            if (xlsxOperationRef.current !== operation) return;
            operation.activity = { ...operation.activity, progress };
            updateXlsxOperation(requestId, operation.activity);
          },
        );
        if (controller.signal.aborted) return;
        appRuntime.downloadXlsx(bytes, filename);
      } catch (error) {
        if (isAbortError(error)) return;
        console.error("Item export failed (item-export-failed).");
        alert("アイテムの出力に失敗しました。");
      } finally {
        if (xlsxOperationRef.current === operation) {
          xlsxOperationRef.current = null;
          clearXlsxOperation(requestId);
        }
      }

      confirmEventOverlay();
    },
    [
      exportEventName,
      eventLists,
      clearXlsxOperation,
      confirmEventOverlay,
      eventMetadata,
      executeModeItems,
      dayModes,
      mapData,
      mapRotationSettings,
      mapViewportSettings,
      routeSettings,
      hallDefinitions,
      hallRouteSettings,
      appRuntime,
      startXlsxOperation,
      updateXlsxOperation,
    ],
  );

  const handleExportFileImport = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      e.target.value = "";

      xlsxOperationRef.current?.controller.abort();
      const controller = new AbortController();
      const initialActivity: XlsxOperationActivity = {
        kind: "import",
        progress: null,
        cancelRequested: false,
      };
      const requestId = startXlsxOperation(initialActivity);
      const operation: ActiveXlsxOperation = {
        controller,
        requestId,
        activity: initialActivity,
      };
      xlsxOperationRef.current = operation;
      try {
        const input = await file.arrayBuffer();
        if (controller.signal.aborted) return;
        const response = await appRuntime.xlsxCommands.importWorkbook(
          { kind: "event-import", input, fileName: file.name },
          controller.signal,
          (_requestId, progress) => {
            if (xlsxOperationRef.current !== operation) return;
            operation.activity = { ...operation.activity, progress };
            updateXlsxOperation(requestId, operation.activity);
          },
        );
        if (response.kind !== "event-import") {
          throw new Error("XLSX Worker returned an unexpected result kind.");
        }
        const result = response.value;

        if (!result.success) {
          alert(`インポートに失敗しました:\n${result.errors.join("\n")}`);
          return;
        }

        const fallbackWarnings = result.itemFallbackWarnings || [];
        const skippedItemIds = new Set<string>();
        const BULK_APPROVAL_THRESHOLD = 6;

        const describeFallbackWarning = (
          warning: ItemFallbackWarning,
        ): string =>
          `${warning.rowNumber}行目\n${warning.reasons.map((reason) => `- ${reason}`).join("\n")}`;

        if (fallbackWarnings.length >= BULK_APPROVAL_THRESHOLD) {
          const previewLines = fallbackWarnings
            .slice(0, 5)
            .map(
              (warning) =>
                `- ${warning.rowNumber}行目: ${warning.reasons[0] || "補完が必要です"}`,
            );
          const previewText = previewLines.join("\n");
          const hasMore = fallbackWarnings.length > 5 ? "\n- ..." : "";

          const complementAll = window.confirm(
            `不正データが${fallbackWarnings.length}件見つかりました。\n${previewText}${hasMore}\n\nOK: すべて補完して取り込む\nキャンセル: すべてスキップ`,
          );

          if (!complementAll) {
            fallbackWarnings.forEach((warning) => {
              skippedItemIds.add(warning.itemId);
            });
          }
        } else {
          for (const warning of fallbackWarnings) {
            const shouldComplement = window.confirm(
              `不正データを検出しました。\n${describeFallbackWarning(warning)}\n\nOK: この行を補完して取り込む\nキャンセル: この行をスキップ`,
            );
            if (!shouldComplement) {
              skippedItemIds.add(warning.itemId);
            }
          }
        }

        const resolvedItems =
          skippedItemIds.size === 0
            ? result.items
            : result.items.filter((item) => !skippedItemIds.has(item.id));
        if (resolvedItems.length === 0) {
          if (result.items.length > 0 && skippedItemIds.size > 0) {
            alert(
              "不正データをすべてスキップしたため、取り込み対象がありませんでした。",
            );
          } else {
            alert("取り込んだファイルにアイテムが見つかりませんでした。");
          }
          return;
        }

        const fallbackResolutionMessages: string[] = [];
        if (fallbackWarnings.length > 0) {
          const skippedCount = skippedItemIds.size;
          const complementedCount = fallbackWarnings.length - skippedCount;
          if (complementedCount > 0) {
            fallbackResolutionMessages.push(
              `不正データ${complementedCount}件を補完して取り込みました。`,
            );
          }
          if (skippedCount > 0) {
            fallbackResolutionMessages.push(
              `不正データ${skippedCount}件をスキップしました。`,
            );
          }
        }
        const legacySheetFieldFallbackMessage =
          buildLegacySheetFieldFallbackMessage({
            fallbacks: result.legacySheetFieldFallbacks || [],
            skippedItemIds,
          });
        if (legacySheetFieldFallbackMessage) {
          fallbackResolutionMessages.push(legacySheetFieldFallbackMessage);
        }

        const resolvedResult = {
          ...result,
          items: resolvedItems,
          errors: [...result.errors, ...fallbackResolutionMessages],
        };

        if (resolvedResult.items.length === 0) {
          alert("取り込んだファイルにアイテムが見つかりませんでした。");
          return;
        }

        const importedData = toImportedEventData(resolvedResult);
        const restoreSource = buildXlsxEventRestoreSource(importedData);
        const validation = parseAppBackup(
          createAppBackup(restoreSource.data, new Date(), {
            blockDetectionSettings: restoreSource.blockDetectionSettings,
          }),
        );
        if (!validation.ok) {
          alert(
            `Excel復元データを検証できませんでした。\n${validation.errors.join("\n")}`,
          );
          return;
        }

        openBackupRestore(validation.backup, {
          errors: importedData.errors,
          itemCount: importedData.items.length,
        });
      } catch (error) {
        if (isAbortError(error)) return;
        console.error("Item import failed (item-import-failed).");
        alert(
          "アイテムの取り込みに失敗しました。ファイル形式を確認してください。",
        );
      } finally {
        if (xlsxOperationRef.current === operation) {
          xlsxOperationRef.current = null;
          clearXlsxOperation(requestId);
        }
      }
    },
    [
      appRuntime.xlsxCommands,
      clearXlsxOperation,
      openBackupRestore,
      startXlsxOperation,
      updateXlsxOperation,
    ],
  );

  return {
    backupFileInputRef,
    cancelXlsxOperation,
    handleExportEvent,
    handleBackupExport,
    handlePersistenceRecoveryExport,
    handleBackupRestoreRequest,
    handleBackupFileImport,
    handleBackupRestore,
    handleConfirmExport,
    handleExportFileImport,
  };
};
