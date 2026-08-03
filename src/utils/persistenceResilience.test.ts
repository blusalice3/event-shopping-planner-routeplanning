import { describe, expect, it } from "vitest";
import {
  PERSISTENCE_CHECKPOINT_KIND,
  PERSISTENCE_CHECKPOINT_SCHEMA_VERSION,
  PersistenceEnvelopeError,
  PersistenceSerializationError,
  canonicalStringifyPersistencePayload,
  createPersistenceCheckpointKey,
  createPersistenceDigest,
  createRuntimeFallbackCandidate,
  createRuntimeFallbackKey,
  createStartupRecoveryBundle,
  createSynchronousFingerprint,
  isPersistenceCheckpoint,
  isPersistenceDigestDescriptor,
  isPersistenceSynchronousFingerprint,
  mergeStartupRecoveryBundles,
  parseRuntimeFallbackCandidate,
  reconcileRuntimeFallbackCandidates,
  serializeRuntimeFallbackCandidate,
  serializeStartupRecoveryBundle,
  verifyPersistenceDigest,
  type PersistenceCheckpoint,
  type RuntimeFallbackCandidate,
} from "./persistenceResilience";

const CREATED_AT = "2026-08-03T00:00:00.000Z";
const STORE_NAME = "shoppingItems";
const RECORD_KEY = "data";

const createCandidate = (
  revision: string,
  baseRevision: string | null,
  payload: unknown = { revision },
) =>
  createRuntimeFallbackCandidate({
    storeName: STORE_NAME,
    key: RECORD_KEY,
    revision,
    baseRevision,
    writerId: "writer-test",
    createdAt: CREATED_AT,
    payload,
  });

const createCheckpoint = async (): Promise<PersistenceCheckpoint> => {
  const [committedDigest, ancestorDigest] = await Promise.all([
    createPersistenceDigest({ revision: "revision-2" }),
    createPersistenceDigest({ revision: "revision-1" }),
  ]);
  return {
    kind: PERSISTENCE_CHECKPOINT_KIND,
    version: PERSISTENCE_CHECKPOINT_SCHEMA_VERSION,
    storeName: STORE_NAME,
    key: RECORD_KEY,
    committedRoot: {
      revision: "revision-2",
      baseRevision: "revision-1",
      digest: committedDigest,
      writerId: "writer-test",
      committedAt: CREATED_AT,
    },
    absorbedCandidates: [
      {
        schemaVersion: 1,
        revision: "revision-1",
        baseRevision: null,
        digest: ancestorDigest,
        writerId: "writer-test",
        createdAt: CREATED_AT,
      },
      {
        schemaVersion: 1,
        revision: "revision-2",
        baseRevision: "revision-1",
        digest: committedDigest,
        writerId: "writer-test",
        createdAt: CREATED_AT,
      },
    ],
    updatedAt: "2026-08-03T00:00:01.000Z",
  };
};

describe("canonicalStringifyPersistencePayload", () => {
  it("objectの挿入順によらず、すべての階層のkeyを昇順に正規化する", () => {
    const first = {
      z: 3,
      nested: { y: true, a: "先頭" },
      array: [{ beta: 2, alpha: 1 }],
    };
    const second = {
      array: [{ alpha: 1, beta: 2 }],
      nested: { a: "先頭", y: true },
      z: 3,
    };

    expect(canonicalStringifyPersistencePayload(first)).toBe(
      '{"array":[{"alpha":1,"beta":2}],"nested":{"a":"先頭","y":true},"z":3}',
    );
    expect(canonicalStringifyPersistencePayload(second)).toBe(
      canonicalStringifyPersistencePayload(first),
    );
  });

  it("plain objectのown enumerable undefinedをJSON互換で省略する", () => {
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.kept = "保持";
    nullPrototype.omitted = undefined;

    expect(
      canonicalStringifyPersistencePayload({
        z: undefined,
        nested: { url: undefined, name: "商品" },
        nullPrototype,
        a: true,
      }),
    ).toBe(
      '{"a":true,"nested":{"name":"商品"},"nullPrototype":{"kept":"保持"}}',
    );
    expect(canonicalStringifyPersistencePayload({ value: undefined })).toBe(
      "{}",
    );
  });

  it.each([
    ["top-level undefined", undefined],
    ["function", { value: () => undefined }],
    ["symbol", { value: Symbol("unsupported") }],
    ["bigint", { value: 1n }],
    ["NaN", { value: Number.NaN }],
    ["Infinity", { value: Number.POSITIVE_INFINITY }],
    ["Date", { value: new Date(CREATED_AT) }],
  ])("%sを明示的に拒否する", (_label, value) => {
    expect(() => canonicalStringifyPersistencePayload(value)).toThrow(
      PersistenceSerializationError,
    );
  });

  it("arrayのundefined要素をnullへ暗黙変換せず拒否する", () => {
    expect(() =>
      canonicalStringifyPersistencePayload(["before", undefined, "after"]),
    ).toThrow(/undefined values are not supported/);
  });

  it("循環参照とsparse arrayを拒否する", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const sparse = new Array(2);
    sparse[1] = "value";

    expect(() => canonicalStringifyPersistencePayload(cyclic)).toThrow(
      /cyclic references/,
    );
    expect(() => canonicalStringifyPersistencePayload(sparse)).toThrow(
      PersistenceSerializationError,
    );
  });

  it("arrayのenumerable・non-enumerable追加propertyを拒否する", () => {
    const withEnumerableProperty = ["value"] as string[] & {
      extra?: string;
    };
    withEnumerableProperty.extra = "unsupported";
    const withNonEnumerableProperty = ["value"];
    Object.defineProperty(withNonEnumerableProperty, "hidden", {
      configurable: true,
      enumerable: false,
      value: "unsupported",
    });

    expect(() =>
      canonicalStringifyPersistencePayload(withEnumerableProperty),
    ).toThrow(/array properties other than dense indices/);
    expect(() =>
      canonicalStringifyPersistencePayload(withNonEnumerableProperty),
    ).toThrow(/array properties other than dense indices/);
  });

  it("array・objectのgetterを実行せずに拒否する", () => {
    let arrayGetterCalls = 0;
    const arrayWithGetter = new Array(1);
    Object.defineProperty(arrayWithGetter, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        arrayGetterCalls += 1;
        return "value";
      },
    });
    let objectGetterCalls = 0;
    const objectWithGetter = {};
    Object.defineProperty(objectWithGetter, "value", {
      configurable: true,
      enumerable: true,
      get: () => {
        objectGetterCalls += 1;
        return "value";
      },
    });

    expect(() => canonicalStringifyPersistencePayload(arrayWithGetter)).toThrow(
      /accessor properties/,
    );
    expect(() =>
      canonicalStringifyPersistencePayload(objectWithGetter),
    ).toThrow(/accessor properties/);
    expect(arrayGetterCalls).toBe(0);
    expect(objectGetterCalls).toBe(0);
  });

  it("array・objectのsymbol keyを拒否する", () => {
    const symbolKey = Symbol("unsupported");
    const arrayWithSymbol = ["value"] as unknown as Record<
      string | symbol,
      unknown
    >;
    arrayWithSymbol[symbolKey] = "symbol value";
    const objectWithSymbol: Record<string | symbol, unknown> = {
      value: "plain",
    };
    objectWithSymbol[symbolKey] = "symbol value";

    expect(() => canonicalStringifyPersistencePayload(arrayWithSymbol)).toThrow(
      /symbol keys/,
    );
    expect(() =>
      canonicalStringifyPersistencePayload(objectWithSymbol),
    ).toThrow(/symbol keys/);
  });

  it("循環していない共有参照は値として正規化できる", () => {
    const shared = { value: "共有" };

    expect(
      canonicalStringifyPersistencePayload({ first: shared, second: shared }),
    ).toBe('{"first":{"value":"共有"},"second":{"value":"共有"}}');
  });
});

describe("persistence digest and synchronous fingerprint", () => {
  it("key順が異なる同一payloadから同じSHA-256 descriptorを作る", async () => {
    const first = await createPersistenceDigest({
      b: [2, { y: "値", x: 1 }],
      a: true,
    });
    const second = await createPersistenceDigest({
      a: true,
      b: [2, { x: 1, y: "値" }],
    });

    expect(first).toEqual({
      algorithm: "SHA-256",
      canonicalization: "esp-json-v1",
      value: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(second).toEqual(first);
    await expect(
      verifyPersistenceDigest({ b: [2, { x: 1, y: "値" }], a: true }, first),
    ).resolves.toBe(true);
    await expect(
      verifyPersistenceDigest({ b: [2, { x: 2, y: "値" }], a: true }, first),
    ).resolves.toBe(false);
  });

  it("同期fingerprintも正規化順に依存せず、変更は検出する", () => {
    const canonical = canonicalStringifyPersistencePayload({
      alpha: "日本語",
      beta: 2,
    });
    const first = createSynchronousFingerprint({
      beta: 2,
      alpha: "日本語",
    });
    const second = createSynchronousFingerprint({
      alpha: "日本語",
      beta: 2,
    });
    const changed = createSynchronousFingerprint({
      alpha: "日本語",
      beta: 3,
    });

    expect(first).toEqual({
      algorithm: "FNV-1A-64",
      canonicalization: "esp-json-v1",
      canonicalLength: canonical.length,
      value: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(second).toEqual(first);
    expect(changed.value).not.toBe(first.value);
  });

  it("省略可能なundefinedの有無でdigest・fingerprintが変化しない", async () => {
    const withUndefined = {
      item: { name: "商品", url: undefined },
      options: [{ label: "必須", note: undefined }],
    };
    const omitted = {
      item: { name: "商品" },
      options: [{ label: "必須" }],
    };

    await expect(createPersistenceDigest(withUndefined)).resolves.toEqual(
      await createPersistenceDigest(omitted),
    );
    expect(createSynchronousFingerprint(withUndefined)).toEqual(
      createSynchronousFingerprint(omitted),
    );
  });

  it("digest・fingerprint descriptorの余分なfieldを拒否する", async () => {
    const digest = await createPersistenceDigest({ value: "digest" });
    const fingerprint = createSynchronousFingerprint({
      value: "fingerprint",
    });

    expect(
      isPersistenceDigestDescriptor({ ...digest, unsupported: true }),
    ).toBe(false);
    expect(
      isPersistenceSynchronousFingerprint({
        ...fingerprint,
        unsupported: true,
      }),
    ).toBe(false);
  });
});

describe("persistence checkpoint", () => {
  it("storeとkeyを予約namespace内の一意なkeyへencodeする", () => {
    expect(
      createPersistenceCheckpointKey("event metadata", "data/primary"),
    ).toBe("__esp_internal__:checkpoint:v1:event%20metadata:data%2Fprimary");
  });

  it("確定rootと吸収済み候補を含むstrict schemaを検証する", async () => {
    const checkpoint = await createCheckpoint();

    expect(isPersistenceCheckpoint(checkpoint)).toBe(true);
    expect(
      isPersistenceCheckpoint(checkpoint, {
        storeName: STORE_NAME,
        key: RECORD_KEY,
      }),
    ).toBe(true);
    expect(
      isPersistenceCheckpoint(checkpoint, { storeName: "other-store" }),
    ).toBe(false);
    expect(isPersistenceCheckpoint(checkpoint, { key: "other-key" })).toBe(
      false,
    );
  });

  it("余分・欠落field、不正digest・日時・文字列・schemaを拒否する", async () => {
    const checkpoint = await createCheckpoint();
    const firstCandidate = checkpoint.absorbedCandidates[0];
    const missingUpdatedAt: Partial<PersistenceCheckpoint> = {
      ...checkpoint,
    };
    delete missingUpdatedAt.updatedAt;

    expect(isPersistenceCheckpoint({ ...checkpoint, unsupported: true })).toBe(
      false,
    );
    expect(isPersistenceCheckpoint(missingUpdatedAt)).toBe(false);
    expect(isPersistenceCheckpoint({ ...checkpoint, version: 2 })).toBe(false);
    expect(isPersistenceCheckpoint({ ...checkpoint, storeName: "" })).toBe(
      false,
    );
    expect(
      isPersistenceCheckpoint({
        ...checkpoint,
        committedRoot: {
          ...checkpoint.committedRoot,
          unsupported: true,
        },
      }),
    ).toBe(false);
    expect(
      isPersistenceCheckpoint({
        ...checkpoint,
        committedRoot: {
          ...checkpoint.committedRoot,
          digest: {
            ...checkpoint.committedRoot.digest,
            value: "0".repeat(63),
          },
        },
      }),
    ).toBe(false);
    expect(
      isPersistenceCheckpoint({
        ...checkpoint,
        committedRoot: {
          ...checkpoint.committedRoot,
          revision: "",
        },
      }),
    ).toBe(false);
    expect(
      isPersistenceCheckpoint({
        ...checkpoint,
        committedRoot: {
          ...checkpoint.committedRoot,
          baseRevision: "",
        },
      }),
    ).toBe(false);
    expect(
      isPersistenceCheckpoint({
        ...checkpoint,
        committedRoot: {
          ...checkpoint.committedRoot,
          committedAt: "not-a-date",
        },
      }),
    ).toBe(false);
    expect(
      isPersistenceCheckpoint({
        ...checkpoint,
        absorbedCandidates: [
          {
            ...firstCandidate,
            schemaVersion: 2,
          },
        ],
      }),
    ).toBe(false);
    expect(
      isPersistenceCheckpoint({
        ...checkpoint,
        absorbedCandidates: [
          {
            ...firstCandidate,
            writerId: "",
          },
        ],
      }),
    ).toBe(false);
    expect(
      isPersistenceCheckpoint({
        ...checkpoint,
        absorbedCandidates: [
          {
            ...firstCandidate,
            createdAt: "invalid",
          },
        ],
      }),
    ).toBe(false);
    expect(
      isPersistenceCheckpoint({
        ...checkpoint,
        updatedAt: "",
      }),
    ).toBe(false);
  });

  it("吸収済み候補内の重複revisionを拒否する", async () => {
    const checkpoint = await createCheckpoint();
    const duplicate = {
      ...checkpoint.absorbedCandidates[0],
      writerId: "another-writer",
    };

    expect(
      isPersistenceCheckpoint({
        ...checkpoint,
        absorbedCandidates: [...checkpoint.absorbedCandidates, duplicate],
      }),
    ).toBe(false);
  });
});

describe("runtime fallback candidate", () => {
  it("namespace keyとimmutable envelopeを生成し、厳格parseで復元する", async () => {
    const candidate = await createCandidate("revision:2", "revision:1", {
      z: 2,
      a: { value: "保持" },
    });
    const storageKey = createRuntimeFallbackKey(
      candidate.storeName,
      candidate.key,
      candidate.revision,
    );
    const serialized = serializeRuntimeFallbackCandidate(candidate);
    const parsed = parseRuntimeFallbackCandidate(serialized, {
      storeName: STORE_NAME,
      key: RECORD_KEY,
      revision: "revision:2",
    });

    expect(storageKey).toBe(
      "esp:idb-fallback:v1:shoppingItems:data:revision%3A2",
    );
    expect(parsed).toEqual(candidate);
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.payload)).toBe(true);
    expect(Object.isFrozen((candidate.payload as { a: unknown }).a)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
    await expect(
      verifyPersistenceDigest(parsed.payload, parsed.digest),
    ).resolves.toBe(true);
  });

  it("payloadのundefined propertyをclone前に省略し、安定して再serializeする", async () => {
    const candidate = await createCandidate("revision:2", "revision:1", {
      name: "商品",
      url: undefined,
      nested: { memo: undefined, enabled: true },
    });
    const payload = candidate.payload as {
      name: string;
      nested: { enabled: boolean };
    };
    const serialized = serializeRuntimeFallbackCandidate(candidate);
    const parsed = parseRuntimeFallbackCandidate(serialized);

    expect(payload).toEqual({
      name: "商品",
      nested: { enabled: true },
    });
    expect(Object.prototype.hasOwnProperty.call(payload, "url")).toBe(false);
    expect(parsed.payload).toEqual(payload);
    expect(serializeRuntimeFallbackCandidate(parsed)).toBe(serialized);
    await expect(
      verifyPersistenceDigest(parsed.payload, parsed.digest),
    ).resolves.toBe(true);
  });

  it("欠落・余分なfield、storage keyとの不一致、不正digestを拒否する", async () => {
    const candidate = await createCandidate("revision-2", "revision-1");
    const valid = JSON.parse(
      serializeRuntimeFallbackCandidate(candidate),
    ) as Record<string, unknown>;

    const withExtra = { ...valid, unsupported: true };
    const missingWriter = { ...valid };
    delete missingWriter.writerId;
    const invalidDigest = {
      ...valid,
      digest: {
        algorithm: "SHA-1",
        canonicalization: "esp-json-v1",
        value: "0".repeat(64),
      },
    };

    expect(() =>
      parseRuntimeFallbackCandidate(JSON.stringify(withExtra)),
    ).toThrow(PersistenceEnvelopeError);
    expect(() =>
      parseRuntimeFallbackCandidate(JSON.stringify(missingWriter)),
    ).toThrow(PersistenceEnvelopeError);
    expect(() =>
      parseRuntimeFallbackCandidate(JSON.stringify(invalidDigest)),
    ).toThrow(PersistenceEnvelopeError);
    expect(() =>
      parseRuntimeFallbackCandidate(JSON.stringify(valid), {
        revision: "different-revision",
      }),
    ).toThrow(/does not match its storage key/);
  });
});

describe("reconcileRuntimeFallbackCandidates", () => {
  it("IDB rootからの単一路を順序によらず解決してheadを返す", async () => {
    const revision2 = await createCandidate("revision-2", "revision-1");
    const revision3 = await createCandidate("revision-3", "revision-2");

    const result = reconcileRuntimeFallbackCandidates(
      { revision: "revision-1", baseRevision: "revision-0" },
      [revision3, revision2],
    );

    expect(result).toMatchObject({
      status: "resolved",
      headRevision: "revision-3",
      head: { revision: "revision-3" },
      chain: [{ revision: "revision-2" }, { revision: "revision-3" }],
      staleCandidates: [],
    });
  });

  it("未知parentを自動採用せずconflictにする", async () => {
    const orphan = await createCandidate("revision-3", "missing-revision");

    const result = reconcileRuntimeFallbackCandidates(
      { revision: "revision-1", baseRevision: "revision-0" },
      [orphan],
    );

    expect(result).toMatchObject({
      status: "conflict",
      reason: "unknown-parent",
      conflictingCandidates: [{ revision: "revision-3" }],
    });
  });

  it("同じparentから生えたsiblingを分岐conflictにする", async () => {
    const siblingA = await createCandidate("revision-2a", "revision-1", {
      value: "A",
    });
    const siblingB = await createCandidate("revision-2b", "revision-1", {
      value: "B",
    });

    const result = reconcileRuntimeFallbackCandidates(
      { revision: "revision-1", baseRevision: "revision-0" },
      [siblingA, siblingB],
    );

    expect(result).toMatchObject({
      status: "conflict",
      reason: "branch",
    });
    if (result.status === "conflict") {
      expect(
        result.conflictingCandidates.map(({ revision }) => revision),
      ).toEqual(expect.arrayContaining(["revision-2a", "revision-2b"]));
    }
  });

  it("IDBの直接・連鎖ancestorをstaleとして分離し、descendantを採用する", async () => {
    const revision1 = await createCandidate("revision-1", "revision-0");
    const revision2 = await createCandidate("revision-2", "revision-1");
    const revision4 = await createCandidate("revision-4", "revision-3");

    const result = reconcileRuntimeFallbackCandidates(
      { revision: "revision-3", baseRevision: "revision-2" },
      [revision1, revision4, revision2],
    );

    expect(result).toMatchObject({
      status: "resolved",
      headRevision: "revision-4",
      head: { revision: "revision-4" },
      chain: [{ revision: "revision-4" }],
    });
    if (result.status === "resolved") {
      expect(result.staleCandidates.map(({ revision }) => revision)).toEqual([
        "revision-2",
        "revision-1",
      ]);
    }
  });

  it("同じrevisionの異なる内容をduplicate conflictにする", async () => {
    const first = await createCandidate("revision-2", "revision-1", {
      value: "first",
    });
    const second = await createCandidate("revision-2", "revision-1", {
      value: "second",
    });

    expect(
      reconcileRuntimeFallbackCandidates(
        { revision: "revision-1", baseRevision: "revision-0" },
        [first, second],
      ),
    ).toMatchObject({
      status: "conflict",
      reason: "duplicate-revision",
    });
  });

  it("異なるstoreまたはkeyのcandidate混在をconflictにする", async () => {
    const first = await createCandidate("revision-2", "revision-1");
    const otherStore = await createRuntimeFallbackCandidate({
      storeName: "events",
      key: RECORD_KEY,
      revision: "revision-3",
      baseRevision: "revision-2",
      writerId: "writer-test",
      createdAt: CREATED_AT,
      payload: { value: "other store" },
    });
    const otherKey = await createRuntimeFallbackCandidate({
      storeName: STORE_NAME,
      key: "other-key",
      revision: "revision-3",
      baseRevision: "revision-2",
      writerId: "writer-test",
      createdAt: CREATED_AT,
      payload: { value: "other key" },
    });

    expect(
      reconcileRuntimeFallbackCandidates(
        { revision: "revision-1", baseRevision: "revision-0" },
        [first, otherStore],
      ),
    ).toMatchObject({
      status: "conflict",
      reason: "mixed-record",
    });
    expect(
      reconcileRuntimeFallbackCandidates(
        { revision: "revision-1", baseRevision: "revision-0" },
        [first, otherKey],
      ),
    ).toMatchObject({
      status: "conflict",
      reason: "mixed-record",
    });
  });

  it("IDBと同じrevisionはdigest欠落・相違ならconflict、一致ならstaleにする", async () => {
    const currentCandidate = await createCandidate(
      "revision-current",
      "revision-parent",
      { value: "current" },
    );
    const differentDigest = await createPersistenceDigest({
      value: "different",
    });

    expect(
      reconcileRuntimeFallbackCandidates(
        {
          revision: "revision-current",
          baseRevision: "revision-parent",
        },
        [currentCandidate],
      ),
    ).toMatchObject({
      status: "conflict",
      reason: "same-revision-different-payload",
    });
    expect(
      reconcileRuntimeFallbackCandidates(
        {
          revision: "revision-current",
          baseRevision: "revision-parent",
          digest: differentDigest,
        },
        [currentCandidate],
      ),
    ).toMatchObject({
      status: "conflict",
      reason: "same-revision-different-payload",
    });

    const matching = reconcileRuntimeFallbackCandidates(
      {
        revision: "revision-current",
        baseRevision: "revision-parent",
        digest: currentCandidate.digest,
      },
      [currentCandidate],
    );
    expect(matching).toMatchObject({
      status: "resolved",
      head: null,
      headRevision: "revision-current",
      chain: [],
      staleCandidates: [{ revision: "revision-current" }],
    });
  });

  it("IDBと同じrevision・digestでもparentまたはwriterが異なればconflictにする", async () => {
    const currentCandidate = await createCandidate(
      "revision-current",
      "revision-parent",
      { value: "current" },
    );

    expect(
      reconcileRuntimeFallbackCandidates(
        {
          revision: currentCandidate.revision,
          baseRevision: "different-parent",
          digest: currentCandidate.digest,
          writerId: currentCandidate.writerId,
          createdAt: currentCandidate.createdAt,
        },
        [currentCandidate],
      ),
    ).toMatchObject({
      status: "conflict",
      reason: "same-revision-different-metadata",
    });
    expect(
      reconcileRuntimeFallbackCandidates(
        {
          revision: currentCandidate.revision,
          baseRevision: currentCandidate.baseRevision,
          digest: currentCandidate.digest,
          writerId: "different-writer",
          createdAt: currentCandidate.createdAt,
        },
        [currentCandidate],
      ),
    ).toMatchObject({
      status: "conflict",
      reason: "same-revision-different-metadata",
    });
    expect(
      reconcileRuntimeFallbackCandidates(
        {
          revision: currentCandidate.revision,
          baseRevision: currentCandidate.baseRevision,
          digest: currentCandidate.digest,
          writerId: currentCandidate.writerId,
          createdAt: "2026-08-03T00:00:01.000Z",
        },
        [currentCandidate],
      ),
    ).toMatchObject({
      status: "conflict",
      reason: "same-revision-different-metadata",
    });
    expect(
      reconcileRuntimeFallbackCandidates(
        {
          revision: currentCandidate.revision,
          baseRevision: currentCandidate.baseRevision,
          digest: currentCandidate.digest,
          writerId: currentCandidate.writerId,
          createdAt: currentCandidate.createdAt,
        },
        [currentCandidate],
      ),
    ).toMatchObject({
      status: "resolved",
      head: null,
      staleCandidates: [{ revision: currentCandidate.revision }],
    });
  });

  it("stale ancestor chainの循環をconflictにする", async () => {
    const revision1 = await createCandidate("revision-1", "revision-2");
    const revision2 = await createCandidate("revision-2", "revision-1");

    expect(
      reconcileRuntimeFallbackCandidates(
        { revision: "revision-3", baseRevision: "revision-2" },
        [revision1, revision2],
      ),
    ).toMatchObject({
      status: "conflict",
      reason: "ancestor-cycle",
      conflictingCandidates: expect.arrayContaining([
        expect.objectContaining({ revision: "revision-1" }),
        expect.objectContaining({ revision: "revision-2" }),
      ]),
    });
  });
});

describe("startup recovery bundle", () => {
  it("破損rawValueを変更せずpretty JSONへ保持し、末尾改行を1つにする", () => {
    const rawValue = '{\r\n  "壊れた値": "\\u0000 trailing  "\r\n';
    const bundle = createStartupRecoveryBundle({
      capturedAt: CREATED_AT,
      issues: [
        {
          stage: "migration",
          code: "invalid-json",
          message: "旧データを解析できませんでした",
          storeName: STORE_NAME,
          key: RECORD_KEY,
        },
      ],
      candidates: [
        {
          id: "legacy-candidate",
          source: "legacy-localStorage",
          storeName: STORE_NAME,
          key: RECORD_KEY,
          rawValue,
        },
      ],
    });

    const serialized = serializeStartupRecoveryBundle(bundle);
    const reparsed = JSON.parse(serialized) as {
      candidates: Array<{ rawValue?: string }>;
    };

    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized.endsWith("\n\n")).toBe(false);
    expect(reparsed.candidates[0].rawValue).toBe(rawValue);
  });

  it("merge時に同一idでも異なるrawValueを上書きせず両方保持する", () => {
    const first = createStartupRecoveryBundle({
      capturedAt: CREATED_AT,
      issues: [],
      candidates: [
        {
          id: "same-id",
          source: "legacy-localStorage",
          rawValue: "first raw value",
        },
      ],
    });
    const second = createStartupRecoveryBundle({
      capturedAt: CREATED_AT,
      issues: [],
      candidates: [
        {
          id: "same-id",
          source: "legacy-localStorage",
          rawValue: "second raw value",
        },
      ],
    });

    const merged = mergeStartupRecoveryBundles([first, second]);

    expect(merged.candidates).toEqual([
      expect.objectContaining({
        id: "same-id",
        rawValue: "first raw value",
      }),
      expect.objectContaining({
        id: "same-id",
        rawValue: "second raw value",
      }),
    ]);
  });

  it("非JSON値をgetter実行なしで独立snapshot化し、常にJSON退避できる", () => {
    let getterCalls = 0;
    const cyclic: Record<string, unknown> = {
      bigint: 123n,
    };
    cyclic.self = cyclic;
    Object.defineProperty(cyclic, "dangerous", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("getter must not run");
      },
    });
    const candidate = {
      id: "non-json-candidate",
      source: "indexedDB" as const,
      payload: cyclic,
    };
    const bundle = createStartupRecoveryBundle({
      capturedAt: CREATED_AT,
      issues: [],
      candidates: [candidate],
    });

    cyclic.bigint = 456n;
    cyclic.afterSnapshot = "must not appear";
    const serialized = serializeStartupRecoveryBundle(bundle);
    const reparsed = JSON.parse(serialized) as {
      candidates: Array<{ payload?: unknown }>;
    };

    expect(getterCalls).toBe(0);
    expect(serialized).toContain('"__espRecoveryValue": "bigint"');
    expect(serialized).toContain('"value": "123"');
    expect(serialized).toContain('"__espRecoveryValue": "reference"');
    expect(serialized).toContain('"__espRecoveryValue": "accessor"');
    expect(serialized).not.toContain("must not appear");
    expect(reparsed.candidates).toHaveLength(1);
    expect(() =>
      mergeStartupRecoveryBundles([
        bundle,
        {
          ...bundle,
          candidates: [candidate],
        },
      ]),
    ).not.toThrow();
  });
});
