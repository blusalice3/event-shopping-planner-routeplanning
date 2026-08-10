import {
  RELEASE_PHASE_GATES,
  nextReleasePhaseGate,
  previousFormalPhaseExitGate,
} from "./phaseGates.mjs";

export const CURRENT_ACCEPTED_PHASE_EXIT = "current-accepted-phase-exit";
export const P8_FLOOR_PREDECESSOR = "P7-IDB";
export const P8_FLOOR_PREPARATION_OPERATIONS = Object.freeze([
  "produce-policy-activation-closure",
  "produce-policy-activation-subject",
]);
const P8_FLOOR_PREPARATION_OPERATION_SET = new Set(
  P8_FLOOR_PREPARATION_OPERATIONS,
);
const CANDIDATE_GATE_ACCEPTANCE_OPERATION_SET = new Set([
  "produce-acceptance-requirements",
  "produce-acceptance-inputs",
  "accept-standard",
]);

// null is a deliberate cycle-breaking exemption.  Every dispatch operation
// must appear here; an absent operation is never treated as exempt.
export const RELEASE_OPERATION_REQUIRED_PREDECESSOR = Object.freeze({
  "produce-artifact-build-requirements": "P0-TOOLCHAIN",
  "build-and-verify": "P0-TOOLCHAIN",
  "produce-policy-activation-qa-build-requirements":
    CURRENT_ACCEPTED_PHASE_EXIT,
  "build-policy-activation-qa": CURRENT_ACCEPTED_PHASE_EXIT,
  "deploy-prebuilt": "P0-ARTIFACT",
  "collect-prepromotion-evidence-source": null,
  "produce-prepromotion-evidence": "P0-ARTIFACT",
  "produce-promotion-subject": "P0-DATA",
  "prepare-and-promote": "P0-DATA",
  "record-promotion": "P0-DATA",
  reconcile: null,
  "initialize-acceptance-collector": null,
  "collect-continuous-sample": null,
  "finalize-acceptance-evidence": null,
  "publish-acceptance-evidence": null,
  "produce-own-gate-performance-evidence": CURRENT_ACCEPTED_PHASE_EXIT,
  "produce-performance-inherited-closure": CURRENT_ACCEPTED_PHASE_EXIT,
  "produce-acceptance-requirements": CURRENT_ACCEPTED_PHASE_EXIT,
  "produce-acceptance-inputs": CURRENT_ACCEPTED_PHASE_EXIT,
  "accept-standard": CURRENT_ACCEPTED_PHASE_EXIT,
  "produce-policy-activation-qa-package": CURRENT_ACCEPTED_PHASE_EXIT,
  "produce-policy-activation-qa-execution-subject": CURRENT_ACCEPTED_PHASE_EXIT,
  "execute-policy-activation-qa": CURRENT_ACCEPTED_PHASE_EXIT,
  "produce-policy-activation-closure": CURRENT_ACCEPTED_PHASE_EXIT,
  "produce-policy-activation-subject": CURRENT_ACCEPTED_PHASE_EXIT,
  "activate-policy": CURRENT_ACCEPTED_PHASE_EXIT,
  "activate-policy-floor": CURRENT_ACCEPTED_PHASE_EXIT,
  "plan-archive-recovery": null,
  "produce-archive-recovery-subject": null,
  "execute-reviewed-archive-recovery": null,
  "collect-remote-db-observation": null,
  "collect-foundation-external-bindings": null,
  "seed-foundation-bootstrap-deployment-binding": null,
  "collect-foundation-bootstrap-recovery": null,
  "produce-foundation-baseline-closure": null,
  "collect-production-request-graph": null,
  "collect-csp-report-observation": null,
  "collect-deployed-csp-flow": null,
  "collect-startup-waf-observation": null,
  "collect-artifact-control-store-drill": null,
  "collect-backup-restore-rehearsal": null,
  "collect-managed-device-live-stage": null,
  "collect-pwa-multiclient-drill": null,
  "produce-phase-exit-authority-bundle": null,
  "publish-phase-exit-authority-bundle": null,
  "attest-phase-exit": null,
  "produce-state-initialization-subject": null,
  "initialize-release-state": null,
  "produce-db-contract-activation-subject": null,
  "activate-db-contract": null,
  "produce-operation-abort-subject": null,
  "abort-pending-operation": null,
});

export const assertReleaseOperationPredecessorCoverage = (operations) => {
  const declared = Object.keys(RELEASE_OPERATION_REQUIRED_PREDECESSOR).sort();
  const actual = [...operations].sort();
  if (JSON.stringify(declared) !== JSON.stringify(actual)) {
    throw new Error(
      "Release operation predecessor map differs from the closed dispatch operation set",
    );
  }
  return true;
};

export const resolveRequiredPhaseExitForOperation = ({
  operation,
  acceptedGate,
  candidateGate = null,
}) => {
  if (!Object.hasOwn(RELEASE_OPERATION_REQUIRED_PREDECESSOR, operation)) {
    throw new Error(
      `Release operation has no formal predecessor policy: ${operation}`,
    );
  }
  if (
    !CANDIDATE_GATE_ACCEPTANCE_OPERATION_SET.has(operation) &&
    candidateGate !== null
  ) {
    throw new Error(
      "Candidate gate is forbidden outside acceptance predecessor routing",
    );
  }
  if (operation === "activate-policy-floor") {
    if (acceptedGate !== "P8-CLEAN") {
      throw new Error(
        "P8 minimum-floor activation requires the live accepted P8-CLEAN gate",
      );
    }
    return P8_FLOOR_PREDECESSOR;
  }
  if (
    acceptedGate === "P8-CLEAN" &&
    P8_FLOOR_PREPARATION_OPERATION_SET.has(operation)
  ) {
    return P8_FLOOR_PREDECESSOR;
  }
  if (CANDIDATE_GATE_ACCEPTANCE_OPERATION_SET.has(operation)) {
    if (!RELEASE_PHASE_GATES.includes(candidateGate)) {
      throw new Error("Acceptance candidate gate is invalid or absent");
    }
    if (candidateGate === acceptedGate) {
      if (candidateGate === "P8-CLEAN") {
        throw new Error(
          "Terminal P8-CLEAN does not permit same-floor acceptance routing",
        );
      }
      return previousFormalPhaseExitGate(candidateGate);
    }
    let expectedCandidateGate;
    try {
      expectedCandidateGate = nextReleasePhaseGate(acceptedGate);
    } catch {
      throw new Error(
        "Acceptance candidate gate must preserve the current floor or advance exactly one gate",
      );
    }
    if (candidateGate !== expectedCandidateGate) {
      throw new Error(
        "Acceptance candidate gate must preserve the current floor or advance exactly one gate",
      );
    }
    return acceptedGate ?? "P0-PROMOTE";
  }
  const requirement = RELEASE_OPERATION_REQUIRED_PREDECESSOR[operation];
  if (requirement !== CURRENT_ACCEPTED_PHASE_EXIT) return requirement;
  if (acceptedGate === null) return "P0-PROMOTE";
  if (!RELEASE_PHASE_GATES.includes(acceptedGate)) {
    throw new Error(
      "Current accepted gate is invalid for predecessor resolution",
    );
  }
  return acceptedGate;
};
