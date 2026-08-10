import { describe, expect, it } from "vitest";
import type { ShoppingItem } from "../../../types/item";
import {
  MAPLESS_HALL_KEY,
  getMaplessKey,
  type HallDefinition,
} from "../../../types/map";
import {
  normalizeHydratedHallState,
  type HydratedHallState,
} from "./normalizeHydratedHallState";

const item = (id: string, eventDate: string): ShoppingItem => ({
  id,
  circle: id,
  eventDate,
  block: "A",
  number: "1",
  title: "",
  price: null,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
});

const maplessHall = (id: string): HallDefinition => ({
  id,
  name: id,
  vertices: [],
  blockNames: ["A"],
});

const polygonHall = (id: string): HallDefinition => ({
  id,
  name: id,
  vertices: [
    { row: 0, col: 0 },
    { row: 0, col: 4 },
    { row: 4, col: 4 },
    { row: 4, col: 0 },
  ],
});

describe("normalizeHydratedHallState", () => {
  it("moves legacy mapless halls and routes to every missing date without mutating input", () => {
    const dayOneKey = getMaplessKey("1日目");
    const dayTwoKey = getMaplessKey("2日目");
    const existingDayTwoHall = maplessHall("existing-day-two");
    const input: HydratedHallState = {
      eventLists: {
        event: [item("one", "1日目"), item("two", "2日目")],
      },
      hallDefinitions: {
        event: {
          [MAPLESS_HALL_KEY]: [maplessHall("legacy")],
          "1日目マップ": [polygonHall("polygon"), maplessHall("from-map")],
          [dayOneKey]: [],
          [dayTwoKey]: [existingDayTwoHall],
        },
      },
      hallRouteSettings: {
        event: {
          [MAPLESS_HALL_KEY]: {
            hallOrder: ["legacy", "from-map"],
            hallVisitLists: [{ hallId: "legacy", itemIds: ["one"] }],
          },
          [dayTwoKey]: {
            hallOrder: ["existing-day-two"],
            hallVisitLists: [],
          },
        },
      },
    };
    const before = structuredClone(input);

    const result = normalizeHydratedHallState(input);

    expect(input).toEqual(before);
    expect(result).not.toBe(input);
    expect(Object.keys(result).sort()).toEqual([
      "eventLists",
      "hallDefinitions",
      "hallRouteSettings",
    ]);
    expect(result.eventLists).toBe(input.eventLists);
    expect(result.hallDefinitions.event[MAPLESS_HALL_KEY]).toBeUndefined();
    expect(result.hallDefinitions.event["1日目マップ"]).toEqual([
      polygonHall("polygon"),
    ]);
    expect(result.hallDefinitions.event[dayOneKey].map(({ id }) => id)).toEqual(
      ["legacy", "from-map"],
    );
    expect(result.hallDefinitions.event[dayTwoKey]).toEqual([
      existingDayTwoHall,
    ]);
    expect(result.hallRouteSettings.event[MAPLESS_HALL_KEY]).toBeUndefined();
    expect(result.hallRouteSettings.event[dayOneKey]).toEqual({
      hallOrder: ["legacy", "from-map"],
      hallVisitLists: [{ hallId: "legacy", itemIds: ["one"] }],
    });
    expect(result.hallRouteSettings.event[dayTwoKey]).toBe(
      input.hallRouteSettings.event[dayTwoKey],
    );
  });

  it("is idempotent and preserves the whole input when no legacy state remains", () => {
    const current: HydratedHallState = {
      eventLists: { event: [item("one", "1日目")] },
      hallDefinitions: {
        event: {
          "1日目マップ": [polygonHall("polygon")],
          [getMaplessKey("1日目")]: [maplessHall("mapless")],
        },
      },
      hallRouteSettings: {
        event: {
          [getMaplessKey("1日目")]: {
            hallOrder: ["mapless"],
            hallVisitLists: [],
          },
        },
      },
    };

    expect(normalizeHydratedHallState(current)).toBe(current);

    const legacy: HydratedHallState = {
      ...current,
      hallDefinitions: {
        event: {
          ...current.hallDefinitions.event,
          [MAPLESS_HALL_KEY]: [maplessHall("legacy")],
        },
      },
    };
    const normalized = normalizeHydratedHallState(legacy);
    expect(normalizeHydratedHallState(normalized)).toBe(normalized);
  });
});
