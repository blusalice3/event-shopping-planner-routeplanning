import { describe, expect, it } from "vitest";
import type { NavigatorReturnPoint } from "../types";
import {
  clearReturnHistory,
  createReturnHistory,
  peekReturnHistory,
  popReturnHistory,
  pushReturnHistory,
} from "./returnHistory";

const point = (
  visitId: string,
  navigatorIndex: number,
): NavigatorReturnPoint<{ mapX: number }> => ({
  visitId,
  navigatorIndex,
  mode: "temporary",
  phase: "normal",
  phaseIndex: navigatorIndex,
  scrollTop: navigatorIndex * 100,
  anchorOffset: -12,
  snapshot: { mapX: navigatorIndex },
});

describe("returnHistory", () => {
  it("uses immutable LIFO semantics for nested temporary moves", () => {
    const empty = createReturnHistory<ReturnType<typeof point>>();
    const first = pushReturnHistory(empty, point("A-01:none", 0));
    const second = pushReturnHistory(first, point("B-02:none", 1));
    const third = pushReturnHistory(second, point("C-03:none", 2));

    expect(empty).toEqual([]);
    expect(first.map((entry) => entry.visitId)).toEqual(["A-01:none"]);
    expect(peekReturnHistory(third)?.visitId).toBe("C-03:none");

    const poppedThird = popReturnHistory(third);
    expect(poppedThird.point?.visitId).toBe("C-03:none");
    expect(poppedThird.history.map((entry) => entry.visitId)).toEqual([
      "A-01:none",
      "B-02:none",
    ]);

    const poppedSecond = popReturnHistory(poppedThird.history);
    expect(poppedSecond.point?.visitId).toBe("B-02:none");
    expect(peekReturnHistory(poppedSecond.history)?.visitId).toBe("A-01:none");
  });

  it("returns a safe empty result when there is nothing to restore", () => {
    expect(popReturnHistory(createReturnHistory())).toEqual({
      point: null,
      history: [],
    });
    expect(peekReturnHistory([])).toBeNull();
  });

  it("clears every return point after a permanent move", () => {
    const history = pushReturnHistory(
      pushReturnHistory(createReturnHistory(), point("A-01:none", 0)),
      point("B-02:none", 1),
    );
    expect(clearReturnHistory()).toEqual([]);
    expect(history).toHaveLength(2);
  });
});
