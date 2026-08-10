import type { DayMapData } from "../../types/map";

export type ParseMapFileResult = {
  data: Record<string, DayMapData> | null;
  skippedSheets: string[];
  error: string | null;
};

export const findZeroBlockMapSheets = (
  data: Record<string, DayMapData>,
): string[] =>
  Object.entries(data)
    .filter(([, mapData]) => mapData.blocks.length === 0)
    .map(
      ([mapName, mapData]) =>
        mapData.sheetName?.trim() || mapName.replace(/マップ$/, ""),
    );
