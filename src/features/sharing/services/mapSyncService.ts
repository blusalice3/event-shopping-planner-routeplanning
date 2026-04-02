import type { SupabaseClient } from '@supabase/supabase-js';
import type { DayMapData, HallDefinition } from '../../../types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseDB = SupabaseClient<any>;

type MapDataType = 'mapData' | 'hallDefinitions';

/**
 * ホストのマップデータ(セルグリッド+ブロック定義)とホール定義をroom_map_dataにupsert。
 * ※routeSettings/hallRouteSettingsは各メンバーが個別設定するため同期対象外。
 */
export async function uploadMapData(
  supabase: SupabaseDB,
  roomId: string,
  eventName: string,
  mapData: Record<string, DayMapData> | undefined,
  hallDefinitions: Record<string, HallDefinition[]> | undefined,
  userId: string,
): Promise<void> {
  const rows: {
    room_id: string;
    data_type: MapDataType;
    map_name: string;
    data: unknown;
    updated_by: string;
    updated_at: string;
  }[] = [];

  const now = new Date().toISOString();

  if (mapData) {
    for (const [mapName, data] of Object.entries(mapData)) {
      rows.push({
        room_id: roomId,
        data_type: 'mapData',
        map_name: mapName,
        data: data as unknown,
        updated_by: userId,
        updated_at: now,
      });
    }
  }

  if (hallDefinitions) {
    for (const [mapName, data] of Object.entries(hallDefinitions)) {
      rows.push({
        room_id: roomId,
        data_type: 'hallDefinitions',
        map_name: mapName,
        data: data as unknown,
        updated_by: userId,
        updated_at: now,
      });
    }
  }

  if (rows.length === 0) return;

  const { error } = await supabase
    .from('room_map_data')
    .upsert(rows, { onConflict: 'room_id,data_type,map_name' });

  if (error) {
    throw new Error(`マップデータ同期に失敗しました: ${error.message}`);
  }
}

/**
 * room_map_dataからmapData+hallDefinitionsを取得して各store形式に変換。
 */
export async function downloadMapData(
  supabase: SupabaseDB,
  roomId: string,
): Promise<{
  mapData?: Record<string, unknown>;
  hallDefinitions?: Record<string, unknown[]>;
}> {
  const { data, error } = await supabase
    .from('room_map_data')
    .select('*')
    .eq('room_id', roomId);

  if (error) {
    throw new Error(`マップデータ取得に失敗しました: ${error.message}`);
  }

  const result: {
    mapData?: Record<string, unknown>;
    hallDefinitions?: Record<string, unknown[]>;
  } = {};

  for (const row of data ?? []) {
    if (row.data_type === 'mapData') {
      if (!result.mapData) result.mapData = {};
      result.mapData[row.map_name] = row.data;
    } else if (row.data_type === 'hallDefinitions') {
      if (!result.hallDefinitions) result.hallDefinitions = {};
      result.hallDefinitions[row.map_name] = row.data as unknown[];
    }
  }

  return result;
}

/**
 * 個別マップデータエントリの更新(mapDataまたはhallDefinitionsのみ)。
 */
export async function updateMapDataEntry(
  supabase: SupabaseDB,
  roomId: string,
  dataType: MapDataType,
  mapName: string,
  data: unknown,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from('room_map_data')
    .upsert(
      {
        room_id: roomId,
        data_type: dataType,
        map_name: mapName,
        data,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'room_id,data_type,map_name' },
    );

  if (error) {
    throw new Error(`マップデータ更新に失敗しました: ${error.message}`);
  }
}
