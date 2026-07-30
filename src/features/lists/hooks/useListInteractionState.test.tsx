// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildRangePresentation } from "../domain/rangeSelection";
import { useListInteractionState } from "./useListInteractionState";

describe("useListInteractionState range anchors", () => {
  it("uses the rendered flat order and toggles exactly the supplied range IDs", () => {
    const presentation = buildRangePresentation({
      scopeKey: "event/day/candidate/flat",
      grouping: "flat",
      itemIds: ["visible-c", "visible-a", "visible-b", "visible-d"],
    });
    const { result } = renderHook(() => useListInteractionState());

    act(() => {
      result.current.selectItemForRange("visible-c", presentation);
    });
    act(() => {
      result.current.selectItemForRange("visible-b", presentation);
    });

    expect(result.current.rangeStart).toEqual({
      kind: "item",
      itemId: "visible-c",
      scopeKey: presentation.scopeKey,
    });
    expect(result.current.rangeEnd).toEqual({
      kind: "item",
      itemId: "visible-b",
      scopeKey: presentation.scopeKey,
    });
    expect([...result.current.selectedItemIds]).toEqual([
      "visible-c",
      "visible-b",
    ]);

    act(() => {
      result.current.toggleRangeItemIdsSelection([
        "visible-c",
        "visible-a",
        "visible-b",
      ]);
    });
    expect([...result.current.selectedItemIds]).toEqual([
      "visible-c",
      "visible-b",
      "visible-a",
    ]);

    act(() => {
      result.current.toggleRangeItemIdsSelection([
        "visible-c",
        "visible-a",
        "visible-b",
      ]);
    });
    expect(result.current.selectedItemIds.size).toBe(0);
    expect(result.current.rangeStart).toBeNull();
    expect(result.current.rangeEnd).toBeNull();
  });

  it("does not reuse an endpoint after the presentation scope changes", () => {
    const firstPresentation = buildRangePresentation({
      scopeKey: "event/day/execute/filter-sold-out",
      grouping: "flat",
      itemIds: ["a", "b", "c"],
    });
    const secondPresentation = buildRangePresentation({
      scopeKey: "event/day/execute/filter-manual",
      grouping: "flat",
      itemIds: ["a", "b", "c", "d"],
    });
    const { result } = renderHook(() => useListInteractionState());

    act(() => {
      result.current.selectItemForRange("a", firstPresentation);
    });
    act(() => {
      result.current.selectItemForRange("c", secondPresentation);
    });

    expect(result.current.rangeStart).toEqual({
      kind: "item",
      itemId: "c",
      scopeKey: secondPresentation.scopeKey,
    });
    expect(result.current.rangeEnd).toBeNull();
  });

  it("starts over when an item click crosses displayed hall groups", () => {
    const presentation = buildRangePresentation({
      scopeKey: "event/day/execute/hall",
      grouping: "hall",
      groups: [
        { key: "east:none", itemIds: ["e1", "e2", "e3"] },
        { key: "west:none", itemIds: ["w1", "w2", "w3"] },
      ],
    });
    const { result } = renderHook(() => useListInteractionState());

    act(() => {
      result.current.selectItemForRange("e1", presentation);
    });
    act(() => {
      result.current.selectItemForRange("w3", presentation);
    });

    expect(result.current.rangeStart).toEqual({
      kind: "item",
      itemId: "w3",
      scopeKey: presentation.scopeKey,
    });
    expect(result.current.rangeEnd).toBeNull();
  });

  it("uses displayed space-group keys for collapsed header anchors", () => {
    const presentation = buildRangePresentation({
      scopeKey: "event/day/execute/space",
      grouping: "space",
      groups: [
        { key: "A-01:priority", itemIds: ["a1", "a2"] },
        { key: "A-01:highest", itemIds: ["b1"] },
        { key: "A-02:priority", itemIds: ["c1", "c2"] },
      ],
    });
    const { result } = renderHook(() => useListInteractionState());

    act(() => {
      result.current.selectSpaceGroupForRange(
        "A-01:priority",
        ["a1", "a2"],
        presentation,
      );
    });
    act(() => {
      result.current.selectSpaceGroupForRange(
        "A-01:highest",
        ["b1"],
        presentation,
      );
    });
    expect(result.current.rangeEnd).toBeNull();

    act(() => {
      result.current.selectSpaceGroupForRange(
        "A-02:priority",
        ["c1", "c2"],
        presentation,
      );
    });
    expect(result.current.rangeEnd).toEqual({
      kind: "group",
      groupKey: "A-02:priority",
      scopeKey: presentation.scopeKey,
    });
  });
});
