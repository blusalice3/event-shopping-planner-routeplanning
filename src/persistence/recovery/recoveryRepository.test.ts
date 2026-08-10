import { describe, expect, it, vi } from "vitest";
import type { StartupRecoveryCandidate } from "../../utils/persistenceResilience";
import { STORES } from "../db/constants";
import type { RecoveryCandidateAdoptionResult } from "./recoveryAdoption";
import { createRecoveryRepository } from "./recoveryRepository";

describe("recovery repository contract", () => {
  it("forwards the exact candidate and preserves the adoption receipt", async () => {
    const candidate: StartupRecoveryCandidate = {
      id: "candidate-1",
      source: "indexedDB",
      storeName: STORES.EVENT_METADATA,
      key: "data",
      payload: { event: { title: "event" } },
    };
    const receipt: RecoveryCandidateAdoptionResult = {
      status: "adopted",
      storeName: STORES.EVENT_METADATA,
      key: "data",
      revision: "revision-1",
      digest: "digest-1",
      archiveKey: "archive-1",
    };
    const adopt = vi.fn(async () => receipt);
    const repository = createRecoveryRepository(adopt);

    await expect(repository.adoptCandidate(candidate)).resolves.toBe(receipt);
    expect(adopt).toHaveBeenCalledExactlyOnceWith(candidate);
  });
});
