import type { ListRendererPreference } from "../preference/ListRendererPreferencePort";
import type { VirtualListEligibility } from "./virtualEligibility";

export type ListRendererEngine = "full" | "virtual";

export type ListRendererSelectionReason =
  | "force-full"
  | "preference-full"
  | "virtual-ineligible"
  | "virtual-eligible";

export interface ListRendererSelection {
  readonly engine: ListRendererEngine;
  readonly reason: ListRendererSelectionReason;
}

export interface ListRendererPolicy {
  readonly forceFull: boolean;
}

export const selectListRenderer = (
  preference: ListRendererPreference,
  eligibility: VirtualListEligibility,
  policy: ListRendererPolicy = { forceFull: false },
): ListRendererSelection => {
  if (policy.forceFull) {
    return { engine: "full", reason: "force-full" };
  }
  if (preference === "full") {
    return { engine: "full", reason: "preference-full" };
  }
  if (!eligibility.eligible) {
    return { engine: "full", reason: "virtual-ineligible" };
  }
  return { engine: "virtual", reason: "virtual-eligible" };
};
