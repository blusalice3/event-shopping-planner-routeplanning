import { describe, expect, it, vi } from "vitest";
import {
  RELEASE_IDENTITY_PROTOCOL_VERSION,
  RELEASE_IDENTITY_RESPONSE_TYPE,
  ReleaseIdentityProtocolError,
  parseCanonicalReleaseIdentity,
  queryReleaseIdentity,
  type GetReleaseIdentityRequest,
  type ReleaseIdentityResponse,
} from "./releaseIdentityProtocol";

const SOURCE_SHA = "1".repeat(40);
const VARIANT_ID = "2".repeat(64);
const SHA = "3".repeat(64);

const canonicalize = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
};

const identityBytes = canonicalize({
  schemaVersion: 1,
  sourceSha: SOURCE_SHA,
  buildId: SOURCE_SHA,
  variantId: VARIANT_ID,
  releaseRole: "standard",
  requiredDbCompatibilityFingerprint: SHA,
  pwaLifecycle: "prompt-close-all-v1",
  roleEntryUrl: "/assets/standard-entry.js",
  roleEntrySha256: SHA,
  serviceWorkerUrl: "/sw.js",
  serviceWorkerSha256: SHA,
  outerAgentUrl: "/assets/outer-agent.js",
  outerAgentSha256: SHA,
});

type TestPort = {
  onmessage: ((event: { data: unknown }) => void) | null;
  onmessageerror: (() => void) | null;
  start: () => void;
  close: () => void;
  closed: boolean;
  postMessage(message: unknown): void;
};

const createTestChannel = (): {
  port1: TestPort;
  port2: TestPort;
} => {
  const port1: TestPort = {
    onmessage: null,
    onmessageerror: null,
    start() {},
    close() {
      port1.closed = true;
    },
    closed: false,
    postMessage(message: unknown) {
      queueMicrotask(() => port2.onmessage?.({ data: message }));
    },
  };
  const port2: TestPort = {
    onmessage: null,
    onmessageerror: null,
    start() {},
    close() {
      port2.closed = true;
    },
    closed: false,
    postMessage(message: unknown) {
      queueMicrotask(() => port1.onmessage?.({ data: message }));
    },
  };
  return { port1, port2 };
};

const successResponse = (
  request: GetReleaseIdentityRequest,
): ReleaseIdentityResponse => ({
  type: RELEASE_IDENTITY_RESPONSE_TYPE,
  protocolVersion: RELEASE_IDENTITY_PROTOCOL_VERSION,
  requestId: request.requestId,
  ok: true,
  workerState: request.expectedWorkerState,
  scriptUrl: "https://planner.test/sw.js",
  versionedIdentityUrl: `/release-identity.${SOURCE_SHA}.${VARIANT_ID}.json`,
  canonicalIdentityBytes: identityBytes,
});

describe("release identity protocol", () => {
  it("accepts exact canonical prompt-close-all identity bytes", () => {
    expect(parseCanonicalReleaseIdentity(identityBytes)).toMatchObject({
      sourceSha: SOURCE_SHA,
      variantId: VARIANT_ID,
      pwaLifecycle: "prompt-close-all-v1",
      releaseRole: "standard",
    });
  });

  it("rejects semantically equal but non-canonical identity bytes", () => {
    const parsed = JSON.parse(identityBytes);
    expect(() =>
      parseCanonicalReleaseIdentity(JSON.stringify(parsed, null, 2)),
    ).toThrowError(ReleaseIdentityProtocolError);
  });

  it("queries a selected worker over a dedicated MessageChannel", async () => {
    const channel = createTestChannel();
    const target = {
      postMessage(message: unknown, transfer?: readonly unknown[]): void {
        expect(transfer).toEqual([channel.port2]);
        const request = message as GetReleaseIdentityRequest;
        expect(request.expectedWorkerState).toBe("waiting");
        channel.port2.postMessage(successResponse(request));
      },
    };

    await expect(
      queryReleaseIdentity(target, "waiting", {
        channelFactory: () => channel,
        requestIdFactory: () => "00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toMatchObject({
      workerState: "waiting",
      identity: {
        sourceSha: SOURCE_SHA,
        pwaLifecycle: "prompt-close-all-v1",
      },
    });
    expect(channel.port1.closed).toBe(true);
  });

  it("fails closed on a wrong response request ID", async () => {
    const channel = createTestChannel();
    const target = {
      postMessage(message: unknown): void {
        const request = message as GetReleaseIdentityRequest;
        channel.port2.postMessage({
          ...successResponse(request),
          requestId: "00000000-0000-4000-8000-000000000099",
        });
      },
    };

    await expect(
      queryReleaseIdentity(target, "active", {
        channelFactory: () => channel,
        requestIdFactory: () => "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toMatchObject({ code: "REQUEST_ID_MISMATCH" });
  });

  it("rejects duplicate terminal responses", async () => {
    const channel = createTestChannel();
    const target = {
      postMessage(message: unknown): void {
        const request = message as GetReleaseIdentityRequest;
        const response = successResponse(request);
        channel.port2.postMessage(response);
        channel.port2.postMessage(response);
      },
    };
    await expect(
      queryReleaseIdentity(target, "active", {
        channelFactory: () => channel,
        requestIdFactory: () => "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_RESPONSE" });
  });

  it("times out without changing worker lifecycle", async () => {
    vi.useFakeTimers();
    try {
      const channel = createTestChannel();
      const promise = queryReleaseIdentity({ postMessage: vi.fn() }, "active", {
        channelFactory: () => channel,
        requestIdFactory: () => "00000000-0000-4000-8000-000000000001",
        timeoutMs: 25,
      });
      const rejection = expect(promise).rejects.toMatchObject({
        code: "TIMEOUT",
      });
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
