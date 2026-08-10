import assert from "node:assert/strict";
import test from "node:test";
import handler from "./not-found.mjs";

for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
  test(`unknown API returns the closed JSON 404 for ${method}`, () => {
    const headers = new Map();
    const response = {
      statusCode: 0,
      body: "",
      setHeader(name, value) {
        headers.set(name.toLowerCase(), value);
      },
      end(body) {
        this.body = body;
      },
    };
    handler(
      {
        get body() {
          throw new Error("not-found handler must not read a request body");
        },
        get headers() {
          throw new Error("not-found handler must not read headers");
        },
        method,
      },
      response,
    );
    assert.equal(response.statusCode, 404);
    assert.equal(response.body, '{"error":"api-not-found"}');
    assert.equal(headers.get("cache-control"), "no-store");
    assert.equal(
      headers.get("content-type"),
      "application/json; charset=utf-8",
    );
  });
}
