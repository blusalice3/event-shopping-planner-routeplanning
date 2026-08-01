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
  ) => void;
}

export const dispatchPreparedMapImport = (
  preparedImport: PreparedMapImport,
  effects: MapImportDispatchEffects,
): "confirmation" | "committed" => {
  if (preparedImport.plan.requiresConfirmation) {
    effects.requestConfirmation(preparedImport);
    return "confirmation";
  }

  effects.commit(preparedImport, {
    preserveMaplessHalls: true,
  });
  return "committed";
};

export interface MapImportCommitEffects {
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
  saveBlockDetectionSettings: (
    eventName: string,
    settings: BlockDetectionSettings,
  ) => void;
  activateTarget: (eventName: string, mapTabName: string) => void;
  finishImport: () => void;
  notify: (message: string) => void;
}

export const commitPreparedMapImport = ({
  state,
  preparedImport,
  options,
  effects,
}: {
  state: MapReimportState;
  preparedImport: PreparedMapImport;
  options: MapReimportOptions;
  effects: MapImportCommitEffects;
}): void => {
  const nextState = applyMapReimportPlan(state, preparedImport.plan, options);

  if (nextState.eventLists !== state.eventLists) {
    effects.setEventLists(nextState.eventLists);
  }
  effects.setMapData(nextState.mapData);
  effects.setMapRotationSettings(nextState.mapRotationSettings);
  effects.setRouteSettings(nextState.routeSettings);
  effects.setHallDefinitions(nextState.hallDefinitions);
  effects.setHallRouteSettings(nextState.hallRouteSettings);
  effects.setMapViewportSettings(nextState.mapViewportSettings);
  effects.saveBlockDetectionSettings(
    preparedImport.plan.eventName,
    preparedImport.settings,
  );

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
