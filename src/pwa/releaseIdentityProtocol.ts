export const RELEASE_IDENTITY_PROTOCOL_VERSION = 1 as const;
export const RELEASE_IDENTITY_REQUEST_TYPE = "GET_RELEASE_IDENTITY" as const;
export const RELEASE_IDENTITY_RESPONSE_TYPE =
  "RELEASE_IDENTITY_RESPONSE" as const;
export const RELEASE_IDENTITY_TIMEOUT_MS = 2_000;

export type ReleaseRole = "standard" | "containment";
export type WorkerLifecycleState = "active" | "waiting";

type ReleaseIdentityBase = {
  schemaVersion: 1;
  sourceSha: string;
  buildId: string;
  variantId: string;
  releaseRole: ReleaseRole;
  requiredDbCompatibilityFingerprint: string;
};

export type LegacyAutoUpdateReleaseIdentity = ReleaseIdentityBase & {
  pwaLifecycle: "legacy-auto-update-v1";
  appEntryUrl: string;
  appEntrySha256: string;
  serviceWorkerUrl: string;
  serviceWorkerSha256: string;
};

export type PromptCloseAllReleaseIdentity = ReleaseIdentityBase & {
  pwaLifecycle: "prompt-close-all-v1";
  roleEntryUrl: string;
  roleEntrySha256: string;
  serviceWorkerUrl: string;
  serviceWorkerSha256: string;
  outerAgentUrl: string;
  outerAgentSha256: string;
};

export type ReleaseIdentity =
  | LegacyAutoUpdateReleaseIdentity
  | PromptCloseAllReleaseIdentity;

export type GetReleaseIdentityRequest = {
  type: typeof RELEASE_IDENTITY_REQUEST_TYPE;
  protocolVersion: typeof RELEASE_IDENTITY_PROTOCOL_VERSION;
  requestId: string;
  expectedWorkerState: WorkerLifecycleState;
};

export type ReleaseIdentityErrorCode =
  | "IDENTITY_NOT_PRECACHED"
  | "IDENTITY_READ_FAILED"
  | "INVALID_REQUEST"
  | "PROTOCOL_MISMATCH"
  | "WORKER_STATE_MISMATCH";

export type ReleaseIdentityResponse =
  | {
      type: typeof RELEASE_IDENTITY_RESPONSE_TYPE;
      protocolVersion: typeof RELEASE_IDENTITY_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      workerState: WorkerLifecycleState;
      scriptUrl: string;
      versionedIdentityUrl: string;
      canonicalIdentityBytes: string;
    }
  | {
      type: typeof RELEASE_IDENTITY_RESPONSE_TYPE;
      protocolVersion: typeof RELEASE_IDENTITY_PROTOCOL_VERSION;
      requestId: string;
      ok: false;
      workerState: WorkerLifecycleState;
      errorCode: ReleaseIdentityErrorCode;
    };

export type VerifiedWorkerIdentity = {
  workerState: WorkerLifecycleState;
  scriptUrl: string;
  versionedIdentityUrl: string;
  canonicalIdentityBytes: string;
  identity: ReleaseIdentity;
};

export type WorkerMessageTarget = {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
};

type MessagePortLike = {
  onmessage: ((event: { data: unknown }) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  start?: () => void;
  close?: () => void;
};

type MessageChannelLike = {
  port1: MessagePortLike;
  port2: unknown;
};

export type ReleaseIdentityQueryOptions = {
  timeoutMs?: number;
  requestIdFactory?: () => string;
  channelFactory?: () => MessageChannelLike;
};

export class ReleaseIdentityProtocolError extends Error {
  readonly code:
    | "CHANNEL_ERROR"
    | "DUPLICATE_RESPONSE"
    | "INVALID_IDENTITY"
    | "INVALID_RESPONSE"
    | "REQUEST_ID_MISMATCH"
    | "TIMEOUT"
    | "WORKER_REJECTED";

  constructor(code: ReleaseIdentityProtocolError["code"], message: string) {
    super(message);
    this.name = "ReleaseIdentityProtocolError";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const isFullSha = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const isLocalAbsolutePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.startsWith("/") &&
  !value.startsWith("//") &&
  !value.includes("\\") &&
  !/[?#]/.test(value) &&
  !/%(?:2e|2f|5c)/i.test(value) &&
  !value.split("/").some((segment) => segment === "." || segment === "..") &&
  !/[\u0000-\u001f\u007f]/.test(value);

const canonicalizeJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Non-finite JSON number.");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Value is not canonical JSON.");
};

const validateBase = (value: Record<string, unknown>): boolean =>
  value.schemaVersion === 1 &&
  isFullSha(value.sourceSha) &&
  value.buildId === value.sourceSha &&
  isSha256(value.variantId) &&
  (value.releaseRole === "standard" || value.releaseRole === "containment") &&
  isSha256(value.requiredDbCompatibilityFingerprint);

export const parseCanonicalReleaseIdentity = (
  canonicalBytes: string,
): ReleaseIdentity => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalBytes);
  } catch {
    throw new ReleaseIdentityProtocolError(
      "INVALID_IDENTITY",
      "Release identity is not valid JSON.",
    );
  }

  if (
    !isRecord(parsed) ||
    canonicalizeJson(parsed) !== canonicalBytes ||
    !validateBase(parsed)
  ) {
    throw new ReleaseIdentityProtocolError(
      "INVALID_IDENTITY",
      "Release identity is not canonical or its base fields are invalid.",
    );
  }

  if (parsed.pwaLifecycle === "legacy-auto-update-v1") {
    const keys = [
      "schemaVersion",
      "sourceSha",
      "buildId",
      "variantId",
      "releaseRole",
      "requiredDbCompatibilityFingerprint",
      "pwaLifecycle",
      "appEntryUrl",
      "appEntrySha256",
      "serviceWorkerUrl",
      "serviceWorkerSha256",
    ] as const;
    if (
      !hasExactKeys(parsed, keys) ||
      !isLocalAbsolutePath(parsed.appEntryUrl) ||
      !isSha256(parsed.appEntrySha256) ||
      !isLocalAbsolutePath(parsed.serviceWorkerUrl) ||
      !isSha256(parsed.serviceWorkerSha256)
    ) {
      throw new ReleaseIdentityProtocolError(
        "INVALID_IDENTITY",
        "Legacy release identity fields are invalid.",
      );
    }
    return parsed as LegacyAutoUpdateReleaseIdentity;
  }

  if (parsed.pwaLifecycle === "prompt-close-all-v1") {
    const keys = [
      "schemaVersion",
      "sourceSha",
      "buildId",
      "variantId",
      "releaseRole",
      "requiredDbCompatibilityFingerprint",
      "pwaLifecycle",
      "roleEntryUrl",
      "roleEntrySha256",
      "serviceWorkerUrl",
      "serviceWorkerSha256",
      "outerAgentUrl",
      "outerAgentSha256",
    ] as const;
    if (
      !hasExactKeys(parsed, keys) ||
      !isLocalAbsolutePath(parsed.roleEntryUrl) ||
      !isSha256(parsed.roleEntrySha256) ||
      !isLocalAbsolutePath(parsed.serviceWorkerUrl) ||
      !isSha256(parsed.serviceWorkerSha256) ||
      !isLocalAbsolutePath(parsed.outerAgentUrl) ||
      !isSha256(parsed.outerAgentSha256)
    ) {
      throw new ReleaseIdentityProtocolError(
        "INVALID_IDENTITY",
        "Prompt-close-all release identity fields are invalid.",
      );
    }
    return parsed as PromptCloseAllReleaseIdentity;
  }

  throw new ReleaseIdentityProtocolError(
    "INVALID_IDENTITY",
    "Release identity lifecycle is not supported.",
  );
};

export const isGetReleaseIdentityRequest = (
  value: unknown,
): value is GetReleaseIdentityRequest =>
  isRecord(value) &&
  hasExactKeys(value, [
    "type",
    "protocolVersion",
    "requestId",
    "expectedWorkerState",
  ]) &&
  value.type === RELEASE_IDENTITY_REQUEST_TYPE &&
  value.protocolVersion === RELEASE_IDENTITY_PROTOCOL_VERSION &&
  typeof value.requestId === "string" &&
  /^[0-9a-f-]{36}$/i.test(value.requestId) &&
  (value.expectedWorkerState === "active" ||
    value.expectedWorkerState === "waiting");

const parseResponse = (value: unknown): ReleaseIdentityResponse => {
  if (
    !isRecord(value) ||
    value.type !== RELEASE_IDENTITY_RESPONSE_TYPE ||
    value.protocolVersion !== RELEASE_IDENTITY_PROTOCOL_VERSION ||
    typeof value.requestId !== "string" ||
    (value.workerState !== "active" && value.workerState !== "waiting") ||
    typeof value.ok !== "boolean"
  ) {
    throw new ReleaseIdentityProtocolError(
      "INVALID_RESPONSE",
      "Worker returned an invalid identity response.",
    );
  }

  if (value.ok) {
    if (
      !hasExactKeys(value, [
        "type",
        "protocolVersion",
        "requestId",
        "ok",
        "workerState",
        "scriptUrl",
        "versionedIdentityUrl",
        "canonicalIdentityBytes",
      ]) ||
      typeof value.scriptUrl !== "string" ||
      typeof value.versionedIdentityUrl !== "string" ||
      typeof value.canonicalIdentityBytes !== "string"
    ) {
      throw new ReleaseIdentityProtocolError(
        "INVALID_RESPONSE",
        "Worker identity success payload is invalid.",
      );
    }
    return value as ReleaseIdentityResponse;
  }

  if (
    !hasExactKeys(value, [
      "type",
      "protocolVersion",
      "requestId",
      "ok",
      "workerState",
      "errorCode",
    ]) ||
    ![
      "IDENTITY_NOT_PRECACHED",
      "IDENTITY_READ_FAILED",
      "INVALID_REQUEST",
      "PROTOCOL_MISMATCH",
      "WORKER_STATE_MISMATCH",
    ].includes(String(value.errorCode))
  ) {
    throw new ReleaseIdentityProtocolError(
      "INVALID_RESPONSE",
      "Worker identity error payload is invalid.",
    );
  }
  return value as ReleaseIdentityResponse;
};

const defaultRequestIdFactory = (): string => crypto.randomUUID();

const defaultChannelFactory = (): MessageChannelLike =>
  new MessageChannel() as unknown as MessageChannelLike;

export const queryReleaseIdentity = (
  target: WorkerMessageTarget,
  workerState: WorkerLifecycleState,
  options: ReleaseIdentityQueryOptions = {},
): Promise<VerifiedWorkerIdentity> => {
  const timeoutMs = options.timeoutMs ?? RELEASE_IDENTITY_TIMEOUT_MS;
  const requestId = (options.requestIdFactory ?? defaultRequestIdFactory)();
  const channel = (options.channelFactory ?? defaultChannelFactory)();
  const request: GetReleaseIdentityRequest = {
    type: RELEASE_IDENTITY_REQUEST_TYPE,
    protocolVersion: RELEASE_IDENTITY_PROTOCOL_VERSION,
    requestId,
    expectedWorkerState: workerState,
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let observedResponse = false;
    let responseSettleTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (action: () => void, keepPortOpen = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (responseSettleTimer) clearTimeout(responseSettleTimer);
      if (!keepPortOpen) channel.port1.close?.();
      action();
    };

    const timeout = setTimeout(() => {
      finish(() =>
        reject(
          new ReleaseIdentityProtocolError(
            "TIMEOUT",
            `Release identity request timed out after ${timeoutMs} ms.`,
          ),
        ),
      );
    }, timeoutMs);

    channel.port1.onmessageerror = () => {
      finish(() =>
        reject(
          new ReleaseIdentityProtocolError(
            "CHANNEL_ERROR",
            "Release identity channel failed.",
          ),
        ),
      );
    };

    channel.port1.onmessage = (event) => {
      if (settled) return;
      if (observedResponse) {
        finish(() =>
          reject(
            new ReleaseIdentityProtocolError(
              "DUPLICATE_RESPONSE",
              "Worker sent more than one identity response.",
            ),
          ),
        );
        return;
      }
      observedResponse = true;

      let response: ReleaseIdentityResponse;
      try {
        response = parseResponse(event.data);
      } catch (error) {
        finish(() => reject(error));
        return;
      }

      if (response.requestId !== requestId) {
        finish(() =>
          reject(
            new ReleaseIdentityProtocolError(
              "REQUEST_ID_MISMATCH",
              "Worker response request ID does not match.",
            ),
          ),
        );
        return;
      }
      if (response.workerState !== workerState) {
        finish(() =>
          reject(
            new ReleaseIdentityProtocolError(
              "INVALID_RESPONSE",
              "Worker response state does not match its target.",
            ),
          ),
        );
        return;
      }
      if (!response.ok) {
        finish(() =>
          reject(
            new ReleaseIdentityProtocolError(
              "WORKER_REJECTED",
              `Worker rejected release identity request: ${response.errorCode}.`,
            ),
          ),
        );
        return;
      }

      try {
        const identity = parseCanonicalReleaseIdentity(
          response.canonicalIdentityBytes,
        );
        const verified = {
          workerState: response.workerState,
          scriptUrl: response.scriptUrl,
          versionedIdentityUrl: response.versionedIdentityUrl,
          canonicalIdentityBytes: response.canonicalIdentityBytes,
          identity,
        } satisfies VerifiedWorkerIdentity;
        // Hold the first success through the current task so a worker cannot
        // win a race by emitting two terminal responses.
        responseSettleTimer = setTimeout(
          () => finish(() => resolve(verified)),
          0,
        );
      } catch (error) {
        finish(() => reject(error));
      }
    };

    channel.port1.start?.();
    try {
      target.postMessage(request, [channel.port2]);
    } catch (error) {
      finish(() =>
        reject(
          error instanceof Error
            ? error
            : new ReleaseIdentityProtocolError(
                "CHANNEL_ERROR",
                "Could not send release identity request.",
              ),
        ),
      );
    }
  });
};

export const createReleaseIdentityErrorResponse = (
  requestId: string,
  workerState: WorkerLifecycleState,
  errorCode: ReleaseIdentityErrorCode,
): ReleaseIdentityResponse => ({
  type: RELEASE_IDENTITY_RESPONSE_TYPE,
  protocolVersion: RELEASE_IDENTITY_PROTOCOL_VERSION,
  requestId,
  ok: false,
  workerState,
  errorCode,
});
