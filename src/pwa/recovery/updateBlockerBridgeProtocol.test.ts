import { describe, expect, it } from "vitest";
import {
  ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION,
  ROLE_BLOCKER_SNAPSHOT_REQUEST_TYPE,
  ROLE_BLOCKER_SNAPSHOT_RESPONSE_TYPE,
  isRoleBlockerSnapshotRequest,
  isRoleBlockerSnapshotResponse,
  isUpdateBlockerSnapshot,
} from "./updateBlockerBridgeProtocol";

const requestId = "44444444-4444-4444-8444-444444444444";
const snapshot = {
  clientId: "client-a",
  capturedAt: "2026-08-10T00:00:00.000Z",
  responsive: true,
  blockers: [{ id: "event-autosave", label: "イベントを保存中" }],
  flushError: false,
};

describe("update blocker bridge protocol", () => {
  it("accepts only an exact request envelope", () => {
    const request = {
      type: ROLE_BLOCKER_SNAPSHOT_REQUEST_TYPE,
      protocolVersion: ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION,
      requestId,
      clientId: "client-a",
      flush: false,
    };
    expect(isRoleBlockerSnapshotRequest(request)).toBe(true);
    expect(isRoleBlockerSnapshotRequest({ ...request, extra: true })).toBe(
      false,
    );
    expect(
      isRoleBlockerSnapshotRequest({ ...request, requestId: "predictable" }),
    ).toBe(false);
    expect(isRoleBlockerSnapshotRequest({ ...request, flush: 1 })).toBe(false);
  });

  it("validates every snapshot field and rejects duplicate blockers", () => {
    expect(isUpdateBlockerSnapshot(snapshot)).toBe(true);
    expect(isUpdateBlockerSnapshot({ ...snapshot, capturedAt: "today" })).toBe(
      false,
    );
    expect(isUpdateBlockerSnapshot({ ...snapshot, blockers: null })).toBe(
      false,
    );
    expect(
      isUpdateBlockerSnapshot({
        ...snapshot,
        blockers: [snapshot.blockers[0], snapshot.blockers[0]],
      }),
    ).toBe(false);
    expect(isUpdateBlockerSnapshot({ ...snapshot, extra: true })).toBe(false);
  });

  it("accepts only an exact response with a canonical snapshot", () => {
    const response = {
      type: ROLE_BLOCKER_SNAPSHOT_RESPONSE_TYPE,
      protocolVersion: ROLE_BLOCKER_BRIDGE_PROTOCOL_VERSION,
      requestId,
      snapshot,
    };
    expect(isRoleBlockerSnapshotResponse(response)).toBe(true);
    expect(isRoleBlockerSnapshotResponse({ ...response, extra: true })).toBe(
      false,
    );
    expect(
      isRoleBlockerSnapshotResponse({
        ...response,
        snapshot: { ...snapshot, responsive: "yes" },
      }),
    ).toBe(false);
  });
});
