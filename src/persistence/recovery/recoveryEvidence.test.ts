import { describe, expect, it } from "vitest";
import {
  materializeRecoveryAdoptionCurrentPayload,
  normalizeRecoveryAdoptionPayload,
} from "./recoveryEvidence";

describe("recovery adoption evidence", () => {
  it("rejects non-record payloads and clones an accepted payload", () => {
    expect(() => normalizeRecoveryAdoptionPayload("eventLists", [])).toThrow(
      "recovery payload must be a JSON-compatible object",
    );

    const source = { Event: [{ id: "item-1" }] };
    const normalized = normalizeRecoveryAdoptionPayload("eventLists", source);
    expect(normalized).toEqual(source);
    expect(normalized).not.toBe(source);
  });

  it("requires physical map records but preserves non-map payload identity", () => {
    expect(() =>
      materializeRecoveryAdoptionCurrentPayload("mapData", {
        metadata: null,
        checkpoint: null,
      }),
    ).toThrow("mapData recovery evidence is missing its physical records");

    const payload = { Event: [] };
    expect(
      materializeRecoveryAdoptionCurrentPayload("eventLists", {
        payload,
        metadata: null,
        checkpoint: null,
      }),
    ).toBe(payload);
  });
});
