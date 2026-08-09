export const RELEASE_PHASE_GATES = Object.freeze([
  "P0-RELEASE",
  "P1-PWA",
  "P2A-LOCAL",
  "P2B-REPORT",
  "P3-XLSX",
  "P4-CSP",
  "P5-DUAL",
  "P5-LIST",
  "P6-APP",
  "P7-IDB",
  "P8-CLEAN",
]);

export const PRE_RELEASE_PHASE_EXIT_GATES = Object.freeze([
  "P0-BASELINE",
  "P0-TOOLCHAIN",
  "P0-ARTIFACT",
  "P0-DATA",
  "P0-PROMOTE",
]);

export const FORMAL_PHASE_EXIT_GATES = Object.freeze([
  ...PRE_RELEASE_PHASE_EXIT_GATES,
  ...RELEASE_PHASE_GATES,
]);

// This is the single closed contract for formal exits.  Keep local verifier,
// Release State event, and externally collected authorities in one set so an
// attestation can reject missing, extra, or cross-gate evidence.
export const PHASE_EXIT_REQUIRED_AUTHORITIES = Object.freeze({
  "P0-BASELINE": Object.freeze([
    "foundation-baseline",
    "external-bindings",
    "bootstrap-recovery-drill",
  ]),
  "P0-TOOLCHAIN": Object.freeze(["strict-toolchain", "quality-run"]),
  "P0-ARTIFACT": Object.freeze(["artifact-provider-control-store-drill"]),
  "P0-DATA": Object.freeze([
    "remote-db",
    "retention",
    "backup-restore-rehearsal",
    "startup-waf-observation",
    "state-initialized",
  ]),
  "P0-PROMOTE": Object.freeze(["assignment-validated"]),
  "P0-RELEASE": Object.freeze(["accepted-gate", "physical-performance"]),
  "P1-PWA": Object.freeze(["accepted-gate", "pwa-multiclient-drill"]),
  "P2A-LOCAL": Object.freeze(["accepted-gate", "production-request-graph"]),
  "P2B-REPORT": Object.freeze(["accepted-gate", "csp-report-observation"]),
  "P3-XLSX": Object.freeze(["accepted-gate"]),
  "P4-CSP": Object.freeze(["accepted-gate", "deployed-csp-flow"]),
  "P5-DUAL": Object.freeze(["accepted-gate"]),
  "P5-LIST": Object.freeze(["accepted-gate"]),
  "P6-APP": Object.freeze(["accepted-gate"]),
  "P7-IDB": Object.freeze(["accepted-gate", "idb-device-compatibility"]),
  "P8-CLEAN": Object.freeze([
    "accepted-gate",
    "minimum-safety-floor-activated",
  ]),
});

export const PHASE_EXIT_SUBJECT_KIND_BY_GATE = Object.freeze({
  "P0-BASELINE": "repository-phase-subject/v1",
  "P0-TOOLCHAIN": "repository-phase-subject/v1",
  "P0-ARTIFACT": "disposable-drill-subject/v1",
  "P0-DATA": "state-initialized-bootstrap-subject/v1",
  ...Object.fromEntries(
    [...FORMAL_PHASE_EXIT_GATES]
      .slice(4)
      .map((gate) => [gate, "release-state-subject/v1"]),
  ),
});

export const previousFormalPhaseExitGate = (gate) => {
  const index = FORMAL_PHASE_EXIT_GATES.indexOf(gate);
  if (index < 0) throw new Error(`Unknown formal phase exit gate: ${gate}`);
  return index === 0 ? null : FORMAL_PHASE_EXIT_GATES[index - 1];
};

export const NORMAL_POLICY_ACTIVATION_GATES = Object.freeze([
  "P1-PWA",
  "P2A-LOCAL",
  "P2B-REPORT",
  "P3-XLSX",
  "P4-CSP",
  "P5-DUAL",
  "P5-LIST",
  "P7-IDB",
]);

export const POLICY_ACTIVATION_GATES = Object.freeze([
  ...NORMAL_POLICY_ACTIVATION_GATES,
  "P8-CLEAN",
]);

export const nextReleasePhaseGate = (acceptedGate) => {
  const currentIndex =
    acceptedGate === null ? -1 : RELEASE_PHASE_GATES.indexOf(acceptedGate);
  if (
    (acceptedGate !== null && currentIndex === -1) ||
    currentIndex >= RELEASE_PHASE_GATES.length - 1
  ) {
    throw new Error(
      "Accepted release gate cannot advance outside the phase sequence",
    );
  }
  return RELEASE_PHASE_GATES[currentIndex + 1];
};
