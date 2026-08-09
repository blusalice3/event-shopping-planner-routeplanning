import type { StartupRecoveryCandidate } from "../../utils/persistenceResilience";
import {
  adoptRecoveryCandidateInternal,
  type RecoveryCandidateAdoptionResult,
} from "./recoveryAdoption";

export interface RecoveryRepository {
  adoptCandidate(
    candidate: StartupRecoveryCandidate,
  ): Promise<RecoveryCandidateAdoptionResult>;
}

export type RecoveryCandidateAdoptionOperation = (
  candidate: StartupRecoveryCandidate,
) => Promise<RecoveryCandidateAdoptionResult>;

export function createRecoveryRepository(
  adopt: RecoveryCandidateAdoptionOperation,
): RecoveryRepository {
  return {
    adoptCandidate(candidate) {
      return adopt(candidate);
    },
  };
}

export const recoveryRepository = createRecoveryRepository(
  adoptRecoveryCandidateInternal,
);
