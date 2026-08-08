import { describe, expect, it } from "vitest";
import { selectListRenderer } from "./rendererSelector";
import {
  evaluateVirtualListEligibility,
  type VirtualListEligibilityInput,
} from "./virtualEligibility";

const eligibleInput = (
  overrides: Partial<VirtualListEligibilityInput> = {},
): VirtualListEligibilityInput => ({
  runtimeAvailable: true,
  columnCount: 1,
  zoomPercent: 100,
  supportedZoomPercents: [100],
  dragActive: false,
  modalActive: false,
  recoveryActive: false,
  rowCount: 120,
  minimumRowCount: 80,
  rowHeightPx: 96,
  stableRowHeight: true,
  focusRestorationReady: true,
  stableRowKeys: true,
  ...overrides,
});

describe("virtual list eligibility", () => {
  it("allows only a fully proven eligible state", () => {
    expect(evaluateVirtualListEligibility(eligibleInput())).toEqual({
      eligible: true,
      reason: null,
      rowHeightPx: 96,
    });
  });

  it.each([
    [{ runtimeAvailable: false }, "runtime-unavailable"],
    [{ columnCount: null }, "column-count-unknown"],
    [{ columnCount: 2 }, "multiple-columns"],
    [{ zoomPercent: null }, "zoom-unknown"],
    [{ zoomPercent: 125 }, "zoom-unsupported"],
    [{ dragActive: null }, "drag-state-unknown"],
    [{ dragActive: true }, "drag-active"],
    [{ modalActive: null }, "modal-state-unknown"],
    [{ modalActive: true }, "modal-active"],
    [{ recoveryActive: null }, "recovery-state-unknown"],
    [{ recoveryActive: true }, "recovery-active"],
    [{ rowCount: null }, "row-count-unknown"],
    [{ rowCount: 79 }, "list-too-short"],
    [{ rowHeightPx: null }, "row-height-unknown"],
    [{ stableRowHeight: null }, "row-height-unknown"],
    [{ stableRowHeight: false }, "row-height-unstable"],
    [{ focusRestorationReady: false }, "focus-restoration-unavailable"],
    [{ stableRowKeys: false }, "row-keys-unstable"],
  ] as const)("fails closed for %j", (overrides, reason) => {
    expect(
      evaluateVirtualListEligibility(
        eligibleInput(overrides as Partial<VirtualListEligibilityInput>),
      ),
    ).toMatchObject({ eligible: false, reason });
  });
});

describe("list renderer selector", () => {
  const eligible = evaluateVirtualListEligibility(eligibleInput());
  const ineligible = evaluateVirtualListEligibility(
    eligibleInput({ modalActive: true }),
  );

  it("uses virtual only for auto plus an eligible runtime", () => {
    expect(selectListRenderer("auto", eligible)).toEqual({
      engine: "virtual",
      reason: "virtual-eligible",
    });
    expect(selectListRenderer("auto", ineligible)).toEqual({
      engine: "full",
      reason: "virtual-ineligible",
    });
  });

  it("lets preference and nonproduction policy force the full renderer", () => {
    expect(selectListRenderer("full", eligible)).toMatchObject({
      engine: "full",
      reason: "preference-full",
    });
    expect(
      selectListRenderer("auto", eligible, { forceFull: true }),
    ).toMatchObject({ engine: "full", reason: "force-full" });
  });
});
