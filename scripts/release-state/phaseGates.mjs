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
