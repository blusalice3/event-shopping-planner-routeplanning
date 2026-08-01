import { describe, expect, it } from "vitest";
import { buildLegacySheetFieldFallbackMessage } from "./uiOrchestration";

describe("buildLegacySheetFieldFallbackMessage", () => {
  it("reports one aggregated count after excluding skipped rows", () => {
    expect(
      buildLegacySheetFieldFallbackMessage({
        fallbacks: [
          { itemId: "imported-1" },
          { itemId: "skipped" },
          { itemId: "imported-2" },
        ],
        skippedItemIds: new Set(["skipped"]),
      }),
    ).toBe(
      "旧形式のため、2件のシート品目でカタログ価格とシート備考を現在の価格・備考から推定して補完しました。",
    );
  });

  it("omits the migration message when no fallback row was imported", () => {
    expect(
      buildLegacySheetFieldFallbackMessage({
        fallbacks: [{ itemId: "skipped" }],
        skippedItemIds: new Set(["skipped"]),
      }),
    ).toBeNull();
  });
});
