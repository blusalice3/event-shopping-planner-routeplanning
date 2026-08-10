import { describe, expect, it, vi } from "vitest";
import { STORES } from "./constants";
import {
  openCoordinatedTransaction,
  requestResult,
  transactionFinished,
} from "./transactionCoordinator";

describe("persistence transaction coordinator", () => {
  it("validates every store before opening one coordinated transaction", () => {
    const transaction = {} as IDBTransaction;
    const contains = vi.fn(() => true);
    const openTransaction = vi.fn(() => transaction);
    const database = {
      objectStoreNames: { contains },
      transaction: openTransaction,
    } as unknown as IDBDatabase;

    expect(
      openCoordinatedTransaction(
        database,
        [STORES.EVENT_LISTS, STORES.SYNC_QUEUE],
        "readwrite",
      ),
    ).toBe(transaction);
    expect(contains).toHaveBeenNthCalledWith(1, STORES.EVENT_LISTS);
    expect(contains).toHaveBeenNthCalledWith(2, STORES.SYNC_QUEUE);
    expect(openTransaction).toHaveBeenCalledWith(
      [STORES.EVENT_LISTS, STORES.SYNC_QUEUE],
      "readwrite",
    );
  });

  it("fails before transaction creation when a required store is absent", () => {
    const openTransaction = vi.fn();
    const database = {
      objectStoreNames: { contains: () => false },
      transaction: openTransaction,
    } as unknown as IDBDatabase;

    expect(() =>
      openCoordinatedTransaction(database, STORES.MAP_DATA, "readonly"),
    ).toThrow(`IndexedDB object store is missing: ${STORES.MAP_DATA}`);
    expect(openTransaction).not.toHaveBeenCalled();
  });

  it("preserves request and transaction success/failure identities", async () => {
    const request = {
      error: null,
      result: { value: 1 },
      onerror: null,
      onsuccess: null,
    } as unknown as IDBRequest<{ value: number }>;
    const requestPromise = requestResult(request);
    request.onsuccess?.(new Event("success"));
    await expect(requestPromise).resolves.toEqual({ value: 1 });

    const failure = new DOMException("aborted", "AbortError");
    const transaction = {
      error: failure,
      onabort: null,
      oncomplete: null,
      onerror: null,
    } as unknown as IDBTransaction;
    const transactionPromise = transactionFinished(transaction);
    transaction.onabort?.(new Event("abort"));
    await expect(transactionPromise).rejects.toBe(failure);
  });

  it("supplies closed fallback errors when IndexedDB omits them", async () => {
    const requestFailure = new DOMException("request failed", "UnknownError");
    const failedRequest = {
      error: requestFailure,
      onerror: null,
      onsuccess: null,
    } as unknown as IDBRequest<never>;
    const failedRequestPromise = requestResult(failedRequest);
    failedRequest.onerror?.(new Event("error"));
    await expect(failedRequestPromise).rejects.toBe(requestFailure);

    const missingRequestError = {
      error: null,
      onerror: null,
      onsuccess: null,
    } as unknown as IDBRequest<never>;
    const missingRequestErrorPromise = requestResult(missingRequestError);
    missingRequestError.onerror?.(new Event("error"));
    await expect(missingRequestErrorPromise).rejects.toThrow(
      "IndexedDB request failed.",
    );

    const missingTransactionError = {
      error: null,
      onabort: null,
      oncomplete: null,
      onerror: null,
    } as unknown as IDBTransaction;
    const missingTransactionErrorPromise = transactionFinished(
      missingTransactionError,
    );
    missingTransactionError.onabort?.(new Event("abort"));
    await expect(missingTransactionErrorPromise).rejects.toThrow(
      "IndexedDB transaction was aborted.",
    );
  });
});
