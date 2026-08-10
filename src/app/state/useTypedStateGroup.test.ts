import { describe, expect, it } from "vitest";
import { typedStateGroupReducer } from "./useTypedStateGroup";

type FixtureState = {
  count: number;
  label: string;
};

describe("typedStateGroupReducer", () => {
  const initial: FixtureState = { count: 1, label: "A" };

  it("applies direct and functional field commands without changing siblings", () => {
    const renamed = typedStateGroupReducer(initial, {
      type: "set-field",
      key: "label",
      value: "B",
    });
    const incremented = typedStateGroupReducer(renamed, {
      type: "set-field",
      key: "count",
      value: (count) => count + 1,
    });

    expect(incremented).toEqual({ count: 2, label: "B" });
  });

  it("preserves identity for an Object.is-equal update", () => {
    expect(
      typedStateGroupReducer(initial, {
        type: "set-field",
        key: "count",
        value: (count) => count,
      }),
    ).toBe(initial);
  });
});
