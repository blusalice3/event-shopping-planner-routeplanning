import { describe, expect, it } from "vitest";
import {
  isLegacyMigrationConflictContext,
  isLegacyMigrationJournal,
} from "./legacyMigration";

const digest = {
  algorithm: "SHA-256",
  canonicalization: "esp-json-v1",
  value: "a".repeat(64),
} as const;

describe("legacy migration schema guards", () => {
  it("accepts only an exact conflict context for the addressed store", () => {
    const context = {
      kind: "event-shopping-planner-legacy-migration-conflict",
      version: 1,
      legacyKey: "eventShoppingLists",
      targetKey: "data",
      expectedRawDigest: digest,
    };

    expect(isLegacyMigrationConflictContext(context, "eventLists")).toBe(true);
    expect(isLegacyMigrationConflictContext(context, "mapData")).toBe(false);
    expect(
      isLegacyMigrationConflictContext(
        { ...context, inferredPayload: {} },
        "eventLists",
      ),
    ).toBe(false);
  });

  it("fails closed for malformed or future migration journals", () => {
    expect(isLegacyMigrationJournal(null)).toBe(false);
    expect(
      isLegacyMigrationJournal({
        kind: "event-shopping-planner-legacy-migration",
        schemaVersion: 2,
        entries: [],
        unknownFutureField: true,
      }),
    ).toBe(false);
  });
});
