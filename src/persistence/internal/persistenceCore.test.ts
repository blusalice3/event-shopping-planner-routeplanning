import { describe, expect, it, vi } from "vitest";
import { prepareMetadataForPayload } from "./persistenceCore";

describe("prepareMetadataForPayload", () => {
  it("共有canonical表現から従来と同一のSHA-256とFNV-1A-64を生成する", async () => {
    const encodeSpy = vi.spyOn(TextEncoder.prototype, "encode");
    const metadata = await prepareMetadataForPayload(
      "eventLists",
      "data",
      {
        z: [1, "日本語", { beta: false, alpha: null }],
        a: "イベント",
      },
      "base-revision",
      "fixed-revision",
    );

    expect(metadata.payloadDigest).toEqual({
      algorithm: "SHA-256",
      canonicalization: "esp-json-v1",
      value: "21137d49102dff1f091e8874e8d74a2356dbc16d3247858f0f83c747e90c9a40",
    });
    expect(metadata.payloadFingerprint).toEqual({
      algorithm: "FNV-1A-64",
      canonicalization: "esp-json-v1",
      canonicalLength: 54,
      value: "e91757f3a223ec6c",
    });
    expect(encodeSpy).toHaveBeenCalledTimes(1);
    encodeSpy.mockRestore();
  });
});
