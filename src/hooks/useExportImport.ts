import { useState, useCallback, useRef } from 'react';
import { ShoppingItem, EventMetadata, ExecuteModeItems, DayModeState, ExportOptions, MapDataStore, RouteSettingsStore, HallDefinitionsStore, HallRouteSettingsStore, DayMapData, BlockDetectionSettings, ViewMode } from '../types';
import { exportToXlsx, importFromXlsx, downloadBlob } from '../utils/exportImport';
import { saveBlockDetectionSettings } from '../components/map';

// データから参加日を抽出する関数
const extractEventDates = (items: ShoppingItem[]): string[] => {
  const eventDates = new Set<string>();
  items.forEach(item => {
    if (item.eventDate && item.eventDate.trim()) {
      eventDates.add(item.eventDate.trim());
    }
  });
  return Array.from(eventDates).sort((a, b) => {
    const numA = parseInt(a.match(/\d+/)?.[0] || '0', 10);
    const numB = parseInt(b.match(/\d+/)?.[0] || '0', 10);
    if (numA !== numB) return numA - numB;
    return a.localeCompare(b, 'ja');
  });
};

interface ExportImportDeps {
  eventLists: Record<string, ShoppingItem[]>;
  eventMetadata: Record<string, EventMetadata>;
  executeModeItems: Record<string, ExecuteModeItems>;
  dayModes: Record<string, DayModeState>;
  mapData: MapDataStore;
  routeSettings: RouteSettingsStore;
  hallDefinitions: HallDefinitionsStore;
  hallRouteSettings: HallRouteSettingsStore;
  setEventLists: React.Dispatch<React.SetStateAction<Record<string, ShoppingItem[]>>>;
  setEventMetadata: React.Dispatch<React.SetStateAction<Record<string, EventMetadata>>>;
  setExecuteModeItems: React.Dispatch<React.SetStateAction<Record<string, ExecuteModeItems>>>;
  setDayModes: React.Dispatch<React.SetStateAction<Record<string, DayModeState>>>;
  setMapData: React.Dispatch<React.SetStateAction<MapDataStore>>;
  setRouteSettings: React.Dispatch<React.SetStateAction<RouteSettingsStore>>;
  setHallDefinitions: React.Dispatch<React.SetStateAction<HallDefinitionsStore>>;
  setHallRouteSettings: React.Dispatch<React.SetStateAction<HallRouteSettingsStore>>;
  setActiveEventName: React.Dispatch<React.SetStateAction<string | null>>;
  setActiveTab: React.Dispatch<React.SetStateAction<string>>;
}

export function useExportImport(deps: ExportImportDeps) {
  const {
    eventLists, eventMetadata, executeModeItems, dayModes,
    mapData, routeSettings, hallDefinitions, hallRouteSettings,
    setEventLists, setEventMetadata, setExecuteModeItems, setDayModes,
    setMapData, setRouteSettings, setHallDefinitions, setHallRouteSettings,
    setActiveEventName, setActiveTab,
  } = deps;

  const [showExportOptions, setShowExportOptions] = useState(false);
  const [exportEventName, setExportEventName] = useState<string | null>(null);
  const [mapImportDialogOpen, setMapImportDialogOpen] = useState(false);
  const [mapImportPendingFile, setMapImportPendingFile] = useState<File | null>(null);
  const [mapImportPendingEventName, setMapImportPendingEventName] = useState<string>('');

  const mapFileInputRef = useRef<HTMLInputElement>(null);
  const exportFileInputRef = useRef<HTMLInputElement>(null);

  const handleExportEvent = useCallback((eventName: string) => {
    const itemsToExport = eventLists[eventName];
    if (!itemsToExport || itemsToExport.length === 0) {
      alert('エクスポートするアイテムがありません。');
      return;
    }
    setExportEventName(eventName);
    setShowExportOptions(true);
  }, [eventLists]);

  const handleConfirmExport = useCallback(async (options: ExportOptions) => {
    if (!exportEventName) return;
    
    const itemsToExport = eventLists[exportEventName];
    if (!itemsToExport || itemsToExport.length === 0) {
      return;
    }

    try {
      const blob = await exportToXlsx(
        exportEventName,
        itemsToExport,
        options,
        {
          metadata: eventMetadata[exportEventName],
          executeModeItems,
          dayModes,
          mapData,
          routeSettings,
          hallDefinitions,
          hallRouteSettings,
        }
      );

      const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      const suffix = options.format === 'full' ? 'full' : 'simple';
      const filename = `${exportEventName}_${timestamp}_${suffix}.xlsx`;
      
      downloadBlob(blob, filename);
    } catch (error) {
      console.error('Export error:', error);
      alert('エクスポートに失敗しました。');
    }
    
    setExportEventName(null);
  }, [eventLists, executeModeItems, eventMetadata, dayModes, mapData, routeSettings, hallDefinitions, hallRouteSettings, exportEventName]);

  const handleExportFileImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    e.target.value = '';
    
    try {
      const result = await importFromXlsx(file);
      
      if (!result.success) {
        alert(`インポートに失敗しました:\n${result.errors.join('\n')}`);
        return;
      }
      
      if (result.items.length === 0) {
        alert('インポートするアイテムがありません。');
        return;
      }
      
      let eventName = result.eventName;
      const isUpdate = !!eventLists[eventName];
      
      setEventLists(prev => ({
        ...prev,
        [eventName]: result.items,
      }));
      
      if (result.metadata) {
        setEventMetadata(prev => ({
          ...prev,
          [eventName]: result.metadata as EventMetadata,
        }));
      }
      
      if (result.layoutInfo) {
        if (Object.keys(result.layoutInfo.executeModeItems).length > 0) {
          setExecuteModeItems(prev => ({
            ...prev,
            [eventName]: result.layoutInfo!.executeModeItems,
          }));
        }
        if (Object.keys(result.layoutInfo.dayModes).length > 0) {
          setDayModes(prev => ({
            ...prev,
            [eventName]: result.layoutInfo!.dayModes as unknown as DayModeState,
          }));
        }
      }
      
      if (result.mapData && Object.keys(result.mapData).length > 0) {
        setMapData(prev => ({
          ...prev,
          [eventName]: result.mapData as MapDataStore[string],
        }));
      }
      
      if (result.routeSettings && Object.keys(result.routeSettings).length > 0) {
        setRouteSettings(prev => ({
          ...prev,
          [eventName]: result.routeSettings as RouteSettingsStore[string],
        }));
      }
      
      if (result.hallDefinitions && Object.keys(result.hallDefinitions).length > 0) {
        setHallDefinitions(prev => ({
          ...prev,
          [eventName]: result.hallDefinitions as HallDefinitionsStore[string],
        }));
      }
      
      if (result.hallRouteSettings && Object.keys(result.hallRouteSettings).length > 0) {
        setHallRouteSettings(prev => ({
          ...prev,
          [eventName]: result.hallRouteSettings as HallRouteSettingsStore[string],
        }));
      }
      
      if (result.errors.length > 0) {
        alert(`インポート完了（一部エラーあり）:\n${result.errors.join('\n')}`);
      } else if (isUpdate) {
        alert(`「${eventName}」を更新しました。\n${result.items.length}件のアイテム`);
      } else {
        alert(`「${eventName}」を作成しました。\n${result.items.length}件のアイテム`);
      }
      
      setActiveEventName(eventName);
      const dates = extractEventDates(result.items);
      if (dates.length > 0) {
        setActiveTab(dates[0]);
      }
    } catch (error) {
      console.error('Import error:', error);
      alert('インポートに失敗しました。ファイル形式を確認してください。');
    }
  }, [eventLists, setEventLists, setEventMetadata, setExecuteModeItems, setDayModes, setMapData, setRouteSettings, setHallDefinitions, setHallRouteSettings, setActiveEventName, setActiveTab]);

  const handleImportMapData = useCallback(async (eventName: string) => {
    if (mapFileInputRef.current) {
      mapFileInputRef.current.dataset.eventName = eventName;
      mapFileInputRef.current.click();
    }
  }, []);

  const handleMapFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const eventName = e.target.dataset.eventName;
    
    if (!file || !eventName) return;
    
    setMapImportPendingFile(file);
    setMapImportPendingEventName(eventName);
    setMapImportDialogOpen(true);
    
    e.target.value = '';
  }, []);

  const handleMapImportConfirm = useCallback((parsedData: Record<string, DayMapData>, settings: BlockDetectionSettings) => {
    const eventName = mapImportPendingEventName;
    if (!eventName) return;
    
    saveBlockDetectionSettings(eventName, settings);
    
    setMapData(prev => ({
      ...prev,
      [eventName]: {
        ...(prev[eventName] || {}),
        ...parsedData,
      },
    }));
    
    const mapCount = Object.keys(parsedData).length;
    
    const firstMapName = Object.keys(parsedData)[0];
    if (firstMapName) {
      setActiveTab(firstMapName);
    }
    
    setMapImportDialogOpen(false);
    setMapImportPendingFile(null);
    setMapImportPendingEventName('');
    
    alert(`${mapCount}件のマップデータを取り込みました。`);
  }, [mapImportPendingEventName, setMapData, setActiveTab]);

  const handleMapImportClose = useCallback(() => {
    setMapImportDialogOpen(false);
    setMapImportPendingFile(null);
    setMapImportPendingEventName('');
  }, []);

  return {
    showExportOptions,
    setShowExportOptions,
    exportEventName,
    setExportEventName,
    mapImportDialogOpen,
    mapImportPendingFile,
    mapImportPendingEventName,
    mapFileInputRef,
    exportFileInputRef,
    handleExportEvent,
    handleConfirmExport,
    handleExportFileImport,
    handleImportMapData,
    handleMapFileChange,
    handleMapImportConfirm,
    handleMapImportClose,
  };
}
