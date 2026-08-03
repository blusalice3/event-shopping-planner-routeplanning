import { describe, expect, it, vi } from "vitest";
import {
  PERSISTENCE_RELEASE_A_METRICS_STORAGE_KEY,
  bucketPersistenceStartupDuration,
  calculatePersistenceReleaseARates,
  createPersistenceReleaseAMetricRecorder,
  type PersistenceReleaseAMetricEvent,
} from "./persistenceReleaseAMetrics";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("Release A persistence metrics", () => {
  it("records only the closed privacy-safe event schema", () => {
    const received: PersistenceReleaseAMetricEvent[] = [];
    const recorder = createPersistenceReleaseAMetricRecorder({
      sink: (event) => {
        received.push(event);
      },
      now: () => Date.UTC(2026, 7, 3),
    });
    const unsafeInput = {
      version: 1,
      name: "save",
      outcome: "failed",
      payload: { secret: "利用者データ" },
      error: new Error("private raw error"),
      storeName: "eventLists",
      digest: "private-digest",
    } as unknown as PersistenceReleaseAMetricEvent;

    expect(recorder.record(unsafeInput)).toBe(true);
    expect(received).toEqual([
      {
        version: 1,
        name: "save",
        outcome: "failed",
      },
    ]);
    expect(JSON.stringify(received)).not.toContain("利用者データ");
    expect(JSON.stringify(received)).not.toContain("private raw error");
    expect(JSON.stringify(received)).not.toContain("private-digest");
  });

  it("aggregates the five Release A observation families durably", () => {
    const storage = new MemoryStorage();
    let currentTime = Date.UTC(2026, 7, 3, 0, 0, 0);
    const recorder = createPersistenceReleaseAMetricRecorder({
      storage,
      now: () => currentTime,
    });

    recorder.record({
      version: 1,
      name: "checkpoint-adoption",
      outcome: "adopted",
    });
    recorder.record({
      version: 1,
      name: "checkpoint-adoption",
      outcome: "already-absorbed",
    });
    recorder.record({
      version: 1,
      name: "fallback-repair",
      outcome: "succeeded",
    });
    recorder.record({ version: 1, name: "load", outcome: "conflict" });
    recorder.record({ version: 1, name: "save", outcome: "failed" });
    currentTime += 3_500;
    recorder.record({
      version: 1,
      name: "startup",
      outcome: "recovery-required",
      durationBucket: "3-9999ms",
    });

    expect(recorder.snapshot().counters).toMatchObject({
      checkpointAdoption: {
        adopted: 1,
        alreadyAbsorbed: 1,
        failed: 0,
      },
      fallbackRepair: {
        succeeded: 1,
      },
      load: {
        conflict: 1,
      },
      save: {
        failed: 1,
      },
      startup: {
        recoveryRequired: 1,
      },
      startupDuration: {
        "3-9999ms": 1,
      },
    });

    const restored = createPersistenceReleaseAMetricRecorder({
      storage,
      now: () => currentTime,
    });
    expect(restored.snapshot()).toEqual(recorder.snapshot());
    expect(
      storage.getItem(PERSISTENCE_RELEASE_A_METRICS_STORAGE_KEY),
    ).not.toBeNull();
    expect(calculatePersistenceReleaseARates(recorder.snapshot())).toEqual({
      checkpointAdoptionRate: 1,
      fallbackRepairSuccessRate: 1,
      conflictRate: 1,
      saveFailureRate: 1,
      startupRecoveryRequiredRate: 1,
    });
  });

  it("ignores invalid events and isolates throwing observers", async () => {
    const successfulSink = vi.fn();
    const recorder = createPersistenceReleaseAMetricRecorder({
      sink: () => {
        throw new Error("metrics backend unavailable");
      },
    });
    const unsubscribe = recorder.subscribe(successfulSink);

    expect(
      recorder.record({
        version: 1,
        name: "load",
        outcome: "succeeded",
      }),
    ).toBe(true);
    expect(
      recorder.record({
        version: 1,
        name: "load",
        outcome: "unsupported",
      } as unknown as PersistenceReleaseAMetricEvent),
    ).toBe(false);
    expect(successfulSink).toHaveBeenCalledTimes(1);

    unsubscribe();
    recorder.record({ version: 1, name: "save", outcome: "succeeded" });
    expect(successfulSink).toHaveBeenCalledTimes(1);
  });

  it("resets the bounded aggregate without removing the durable record", () => {
    const storage = new MemoryStorage();
    const recorder = createPersistenceReleaseAMetricRecorder({ storage });
    recorder.record({ version: 1, name: "save", outcome: "failed" });

    const reset = recorder.reset();

    expect(reset.counters.save).toEqual({ succeeded: 0, failed: 0 });
    expect(
      JSON.parse(
        storage.getItem(PERSISTENCE_RELEASE_A_METRICS_STORAGE_KEY) ?? "{}",
      ).counters.save,
    ).toEqual({ succeeded: 0, failed: 0 });
  });

  it("returns null rates until a family has an observation denominator", () => {
    const snapshot = createPersistenceReleaseAMetricRecorder().snapshot();
    expect(calculatePersistenceReleaseARates(snapshot)).toEqual({
      checkpointAdoptionRate: null,
      fallbackRepairSuccessRate: null,
      conflictRate: null,
      saveFailureRate: null,
      startupRecoveryRequiredRate: null,
    });
  });
});

describe("startup duration buckets", () => {
  it.each([
    [-1, "lt-250ms"],
    [0, "lt-250ms"],
    [249, "lt-250ms"],
    [250, "250-999ms"],
    [999, "250-999ms"],
    [1_000, "1-2999ms"],
    [2_999, "1-2999ms"],
    [3_000, "3-9999ms"],
    [9_999, "3-9999ms"],
    [10_000, "gte-10s"],
    [Number.POSITIVE_INFINITY, "lt-250ms"],
  ] as const)("maps %s ms to %s", (duration, expected) => {
    expect(bucketPersistenceStartupDuration(duration)).toBe(expected);
  });
});
