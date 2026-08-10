import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../../api/persistence-release-a-metrics.mjs";

const APP_ORIGIN = "https://planner.example.test";
const APP_HOST = "planner.example.test";
const SOURCE_SHA = "a".repeat(40);
const SUPABASE_PROJECT_REF = "project-ref";
const PROVIDER_PROJECT_ID = "provider-project-id";

const validBody = () => ({
  schemaVersion: 1,
  event: {
    version: 1,
    name: "save",
    outcome: "succeeded",
  },
  buildId: SOURCE_SHA,
  browserFamily: "chromium",
  appMode: "browser-tab",
  online: true,
});

const createRequest = ({
  body = validBody(),
  headers = {},
}: {
  body?: unknown;
  headers?: Record<string, string>;
} = {}) => ({
  method: "POST",
  headers: {
    origin: APP_ORIGIN,
    host: APP_HOST,
    "x-forwarded-host": APP_HOST,
    "x-forwarded-proto": "https",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    ...headers,
  },
  body,
  socket: { encrypted: false },
});

const createResponse = () => {
  const headers = new Map<string, string>();
  return {
    statusCode: 0,
    body: "",
    setHeader(name: string, value: string): void {
      headers.set(name.toLowerCase(), value);
    },
    end(body: string): void {
      this.body = body;
    },
    headers,
  };
};

const expectError = (
  response: ReturnType<typeof createResponse>,
  statusCode: number,
  error: string,
): void => {
  expect(response.statusCode).toBe(statusCode);
  expect(JSON.parse(response.body)).toEqual({ error });
  expect(response.headers.get("cache-control")).toBe("no-store");
};

beforeEach(() => {
  vi.stubEnv("PERSISTENCE_METRICS_ALLOWED_ORIGIN", APP_ORIGIN);
  vi.stubEnv(
    "PERSISTENCE_METRICS_SUPABASE_URL",
    `https://${SUPABASE_PROJECT_REF}.supabase.co`,
  );
  vi.stubEnv(
    "PERSISTENCE_METRICS_SUPABASE_SERVICE_ROLE_KEY",
    "server-only-service-role-key",
  );
  vi.stubEnv("PERSISTENCE_METRICS_EXPECTED_PROJECT_REF", SUPABASE_PROJECT_REF);
  vi.stubEnv(
    "PERSISTENCE_METRICS_EXPECTED_PROVIDER_PROJECT_ID",
    PROVIDER_PROJECT_ID,
  );
  vi.stubEnv("VERCEL_PROJECT_ID", PROVIDER_PROJECT_ID);
  vi.stubEnv("VERCEL_DEPLOYMENT_ID", "deployment-id");
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", APP_HOST);
  vi.stubEnv("VERCEL_URL", "deployment.example.test");
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
  vi.stubEnv("PERSISTENCE_METRICS_ALLOW_GENERIC_FALLBACK", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Release A Vercel metrics API", () => {
  it("rejects arbitrary top-level and event fields", async () => {
    const topLevelResponse = createResponse();
    await handler(
      createRequest({
        body: {
          ...validBody(),
          payload: { title: "利用者データ" },
        },
      }),
      topLevelResponse,
    );
    expectError(topLevelResponse, 400, "invalid-schema");

    const eventResponse = createResponse();
    await handler(
      createRequest({
        body: {
          ...validBody(),
          event: {
            ...validBody().event,
            error: "raw error",
            revision: 42,
            digest: "private-digest",
            key: "eventLists",
          },
        },
      }),
      eventResponse,
    );
    expectError(eventResponse, 400, "invalid-schema");
  });

  it("rejects requests above the byte limit before parsing", async () => {
    const response = createResponse();
    await handler(
      createRequest({
        headers: {
          "content-length": "1025",
        },
      }),
      response,
    );
    expectError(response, 413, "request-too-large");
  });

  it("rejects non-UTF-8 request bytes", async () => {
    const response = createResponse();
    await handler(
      createRequest({
        body: Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]),
      }),
      response,
    );
    expectError(response, 400, "invalid-json");
  });

  it("rejects cross-origin and cross-site requests", async () => {
    const response = createResponse();
    await handler(
      createRequest({
        headers: {
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
      }),
      response,
    );
    expectError(response, 403, "forbidden");
  });

  it("rejects a request without a browser Origin", async () => {
    const response = createResponse();

    await handler(
      createRequest({
        headers: {
          origin: "",
        },
      }),
      response,
    );

    expectError(response, 403, "forbidden");
  });

  it("returns 503 when the server-only configuration is absent", async () => {
    vi.stubEnv("PERSISTENCE_METRICS_EXPECTED_PROVIDER_PROJECT_ID", "");
    const response = createResponse();

    await handler(createRequest(), response);

    expectError(response, 503, "metrics-backend-unavailable");
  });

  it("inserts only the closed cleanup schema through server credentials", async () => {
    const insert = vi.fn(
      async (
        _input: string | URL,
        _init: RequestInit,
      ): Promise<{ ok: boolean }> => ({ ok: true }),
    );
    vi.stubGlobal("fetch", insert);
    const response = createResponse();
    const cleanupBody = {
      ...validBody(),
      event: {
        version: 1,
        name: "cleanup",
        outcome: "key-confirmed-removed",
        mode: "manual",
      },
    };

    await handler(createRequest({ body: cleanupBody }), response);

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual({ accepted: true });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(String(insert.mock.calls[0]?.[0])).toBe(
      `https://${SUPABASE_PROJECT_REF}.supabase.co/rest/v1/persistence_release_a_metric_events`,
    );
    const insertInit = insert.mock.calls[0]?.[1];
    expect(insertInit?.headers).toMatchObject({
      apikey: "server-only-service-role-key",
      authorization: "Bearer server-only-service-role-key",
      "content-type": "application/json",
      prefer: "return=minimal",
    });
    const insertedRow = JSON.parse(String(insertInit?.body));
    expect(insertedRow).toEqual({
      schema_version: 1,
      event_version: 1,
      event_name: "cleanup",
      outcome: "key-confirmed-removed",
      duration_bucket: null,
      cleanup_mode: "manual",
      cleanup_reason: null,
      build_id: SOURCE_SHA,
      browser_family: "chromium",
      app_mode: "browser-tab",
      online: true,
    });
    expect(JSON.stringify(insertedRow)).not.toMatch(
      /payload|raw error|revision|digest|eventLists|利用者データ/,
    );
    expect(insertInit?.redirect).toBe("error");
    expect(insertInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not send a service-role key over remote HTTP", async () => {
    vi.stubEnv(
      "PERSISTENCE_METRICS_SUPABASE_URL",
      "http://project.supabase.co",
    );
    vi.stubEnv(
      "PERSISTENCE_METRICS_SUPABASE_SERVICE_ROLE_KEY",
      "server-only-service-role-key",
    );
    const insert = vi.fn();
    vi.stubGlobal("fetch", insert);
    const response = createResponse();

    await handler(createRequest(), response);

    expectError(response, 503, "metrics-backend-unavailable");
    expect(insert).not.toHaveBeenCalled();
  });

  it("does not log raw transport errors", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("raw error with 利用者データ");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const response = createResponse();

    await handler(createRequest(), response);

    expectError(response, 502, "metrics-insert-failed");
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects generic credential fallback and provider project drift", async () => {
    const insert = vi.fn();
    vi.stubGlobal("fetch", insert);
    vi.stubEnv("SUPABASE_URL", "https://other.supabase.co");
    const genericResponse = createResponse();
    await handler(createRequest(), genericResponse);
    expectError(genericResponse, 503, "metrics-backend-unavailable");

    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_ID", "unexpected-project");
    const providerResponse = createResponse();
    await handler(createRequest(), providerResponse);
    expectError(providerResponse, 503, "metrics-backend-unavailable");
    expect(insert).not.toHaveBeenCalled();
  });

  it("requires a full source SHA in the production request", async () => {
    const response = createResponse();
    await handler(
      createRequest({
        body: {
          ...validBody(),
          buildId: "a234567",
        },
      }),
      response,
    );
    expectError(response, 400, "invalid-schema");
  });
});
