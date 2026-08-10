import type { BlockDetectionSettings } from "../../../types/map";
import {
  applyMapReimportPlan,
  type MapReimportOptions,
  type MapReimportPlan,
  type MapReimportState,
} from "./mapReimport";

export interface PreparedMapImport {
  plan: MapReimportPlan;
  settings: BlockDetectionSettings;
  skippedDays: string[];
}

export interface MapImportDispatchEffects {
  requestConfirmation: (preparedImport: PreparedMapImport) => void;
  commit: (
    preparedImport: PreparedMapImport,
    options: MapReimportOptions,
  ) => Promise<void>;
}

export const dispatchPreparedMapImport = async (
  preparedImport: PreparedMapImport,
  effects: MapImportDispatchEffects,
): Promise<"confirmation" | "committed"> => {
  if (preparedImport.plan.requiresConfirmation) {
    effects.requestConfirmation(preparedImport);
    return "confirmation";
  }

  await effects.commit(preparedImport, {
    preserveMaplessHalls: true,
  });
  return "committed";
};

export interface MapImportCommitEffects {
  commitApplicationSnapshotPatch(
    patch: Pick<
      MapReimportState,
      | "eventLists"
      | "mapData"
      | "mapRotationSettings"
      | "routeSettings"
      | "hallDefinitions"
      | "hallRouteSettings"
      | "mapViewportSettings"
    >,
    eventName: string,
    settings: BlockDetectionSettings,
  ): Promise<void>;
  setEventLists: (value: MapReimportState["eventLists"]) => void;
  setMapData: (value: MapReimportState["mapData"]) => void;
  setMapRotationSettings: (
    value: MapReimportState["mapRotationSettings"],
  ) => void;
  setRouteSettings: (value: MapReimportState["routeSettings"]) => void;
  setHallDefinitions: (value: MapReimportState["hallDefinitions"]) => void;
  setHallRouteSettings: (value: MapReimportState["hallRouteSettings"]) => void;
  setMapViewportSettings: (
    value: MapReimportState["mapViewportSettings"],
  ) => void;
  activateTarget: (eventName: string, mapTabName: string) => void;
  finishImport: () => void;
  notify: (message: string) => void;
}

export const commitPreparedMapImport = async ({
  state,
  preparedImport,
  options,
  effects,
}: {
  state: MapReimportState;
  preparedImport: PreparedMapImport;
  options: MapReimportOptions;
  effects: MapImportCommitEffects;
}): Promise<void> => {
  const nextState = applyMapReimportPlan(state, preparedImport.plan, options);

  await effects.commitApplicationSnapshotPatch(
    {
      eventLists: nextState.eventLists,
      mapData: nextState.mapData,
      mapRotationSettings: nextState.mapRotationSettings,
      routeSettings: nextState.routeSettings,
      hallDefinitions: nextState.hallDefinitions,
      hallRouteSettings: nextState.hallRouteSettings,
      mapViewportSettings: nextState.mapViewportSettings,
    },
    preparedImport.plan.eventName,
    preparedImport.settings,
  );

  if (nextState.eventLists !== state.eventLists) {
    effects.setEventLists(nextState.eventLists);
  }
  effects.setMapData(nextState.mapData);
  effects.setMapRotationSettings(nextState.mapRotationSettings);
  effects.setRouteSettings(nextState.routeSettings);
  effects.setHallDefinitions(nextState.hallDefinitions);
  effects.setHallRouteSettings(nextState.hallRouteSettings);
  effects.setMapViewportSettings(nextState.mapViewportSettings);

  const firstTarget = preparedImport.plan.targets[0];
  if (firstTarget) {
    effects.activateTarget(
      preparedImport.plan.eventName,
      firstTarget.mapTabName,
    );
  }

  const messages = [
    `${preparedImport.plan.targets.length}件のマップタブを取り込みました。`,
    ...[...preparedImport.skippedDays]
      .sort((a, b) => a.localeCompare(b, "ja"))
      .map((dayName) => `${dayName}はないので取り込みしませんでした`),
  ];
  effects.finishImport();
  effects.notify(messages.join("\n"));
};

export interface MapImportCancelEffects {
  clearPendingImport: () => void;
  clearPendingFile: () => void;
  clearPendingEventName: () => void;
}

export const cancelPendingMapImport = (
  effects: MapImportCancelEffects,
): void => {
  effects.clearPendingImport();
  effects.clearPendingFile();
  effects.clearPendingEventName();
};
